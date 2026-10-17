"""Match pending orders against a strictly later observed quote; T+1 uses calendar dates."""
import copy
import math
from .clock import parse

def initial(config):
    cash = float(config["initial_cash"])
    return {"cash":cash,"positions":{},"pending":[],"memory":{},"last_date":None,"last_timestamp":None,"last_slot":None,"interest_remainder":0,"equity":cash,"peak":cash,"max_drawdown":0,"active_revision":None}

def validate_orders(orders, config):
    if not isinstance(orders,list) or len(orders)>50:
        raise ValueError("orders must be an array with at most 50 items")
    for order in orders:
        if not isinstance(order,dict) or order.get("symbol") not in config["universe"] or order.get("side") not in ("buy","sell"):
            raise ValueError("Invalid symbol or side")
        qty = order.get("quantity")
        if type(qty) is not int or not 0<qty<=1_000_000_000 or qty%config["lot_size"]:
            raise ValueError("quantity must be a positive multiple of lot_size")
        if not isinstance(order.get("reason",""),str) or len(order.get("reason",""))>1000:
            raise ValueError("Invalid reason")
    return orders

def settle(state, snapshot, config, actions=None):
    state = copy.deepcopy(state)
    timestamp, slot, date, bars = snapshot["as_of"], snapshot["slot"], snapshot["date"], snapshot["bars"]
    if state["last_slot"] and slot <= state["last_slot"]:
        raise ValueError("A ten-minute slot can only be settled once")
    if state["last_timestamp"] and parse(timestamp) <= parse(state["last_timestamp"]):
        raise ValueError("Observations must advance in actual time")
    events = []
    if state["last_timestamp"]:
        elapsed = (parse(timestamp)-parse(state["last_timestamp"])).total_seconds()
        accrued = max(0,-state["cash"])*config["annual_debt_interest"]*elapsed/(365*86400) + state["interest_remainder"]
        interest = math.floor((accrued+1e-10)*100)/100
        state["interest_remainder"] = max(0,accrued-interest)
        state["cash"] = round(state["cash"]-interest,2)
        if interest:
            events.append({"type":"interest","amount":interest,"elapsed_seconds":elapsed})
        if date == state["last_date"] and elapsed > config["cadence_minutes"]*60*1.5:
            events.append({"type":"gap","message":"两次实际采集间隔超过计划；期间没有模拟成交","from":state["last_timestamp"],"to":timestamp})
    new_day = date != state["last_date"]
    if new_day:
        for pos in state["positions"].values():
            pos["sellable"] = pos["quantity"]
    actions = actions or []
    if len({a["symbol"] for a in actions}) != len(actions):
        raise ValueError("Duplicate corporate actions")
    # Actions are applied once per trading date, before the first observation's pending orders.
    if new_day:
        for action in actions:
            symbol = action["symbol"]
            if action.get("date") != date or not action.get("reference") or symbol not in bars:
                raise ValueError("Corporate action needs a date, quote and source reference")
            for key in ("cash_per_share","quantity_multiplier"):
                if type(action.get(key)) not in (int,float) or not math.isfinite(action[key]):
                    raise ValueError("Invalid corporate-action value")
            if action["cash_per_share"]<0 or action["quantity_multiplier"]<=0:
                raise ValueError("Invalid corporate-action value")
            pos = state["positions"].get(symbol)
            if pos:
                quantity = pos["quantity"]*action["quantity_multiplier"]
                if quantity%config["lot_size"]:
                    raise ValueError("Odd-lot corporate actions require a new ruleset")
                credit = round(pos["quantity"]*action["cash_per_share"],2)
                state["cash"] = round(state["cash"]+credit,2)
                pos.update(quantity=int(quantity),sellable=int(quantity),cost=pos["cost"]/action["quantity_multiplier"],reconciled_on=date)
                events.append({"type":"corporate_action",**action,"cash_credit":credit})
            for order in state["pending"]:
                if order["symbol"] == symbol:
                    events.append({"type":"rejected",**order,"message":"公司行为对账：取消原待成交订单"})
            state["pending"] = [o for o in state["pending"] if o["symbol"] != symbol]
    for symbol,pos in state["positions"].items():
        bar = bars.get(symbol)
        if bar and pos.get("reconciled_on") != date and abs(bar["pre_close"]-bar["reference_close"])>.011:
            raise ValueError(f"Corporate action detected for {symbol}; reconcile {date} before continuing")
    for order in state["pending"]:
        symbol,side,quantity = order["symbol"],order["side"],order["quantity"]
        bar = bars.get(symbol)
        pos = state["positions"].get(symbol,{"quantity":0,"sellable":0,"cost":0})
        rejection = None
        if not bar or bar["vol"]<=0:
            rejection = "无有效盘中报价或停牌"
        elif parse(bar["quote_time"])<=parse(order["submitted_at"]):
            rejection = "报价不晚于策略提交时间，拒绝使用旧价格成交"
        elif not 0<=(parse(timestamp)-parse(bar["quote_time"])).total_seconds()<=config["max_quote_age_seconds"]:
            rejection = "报价过期或来自未来"
        elif side == "buy" and bar["price"]>=bar["up_limit"]-.001:
            rejection = "涨停，保守拒绝买入"
        elif side == "sell" and bar["price"]<=bar["down_limit"]+.001:
            rejection = "跌停，保守拒绝卖出"
        elif side == "sell" and quantity>pos["quantity"]:
            rejection = "持仓不足，禁止融券"
        elif side == "sell" and quantity>pos["sellable"]:
            rejection = "T+1：当日买入份额不可卖出"
        if rejection:
            events.append({"type":"rejected",**order,"message":rejection})
            continue
        direction = 1 if side == "buy" else -1
        price = round(bar["price"]*(1+direction*config["slippage_bps"]/10000),2)
        price = min(bar["up_limit"],max(bar["down_limit"],price))
        gross = round(price*quantity,2)
        fee = round(max(config["minimum_commission"],gross*config["commission_rate"]) + (gross*config["sell_tax_rate"] if side=="sell" else 0),2)
        cash = round(state["cash"]-direction*gross-fee,2)
        if side == "buy" and cash < -config["max_debt"]:
            events.append({"type":"rejected",**order,"message":"超过现金借款上限"})
            continue
        cost = (pos["cost"]*pos["quantity"]+gross+fee)/(pos["quantity"]+quantity) if side=="buy" else pos["cost"]
        state["cash"] = cash
        state["positions"][symbol] = {**pos,"quantity":pos["quantity"]+direction*quantity,"cost":cost,"sellable":pos["sellable"]-(quantity if side=="sell" else 0),"last_price":bar["price"],"quote_time":bar["quote_time"]}
        events.append({"type":"filled",**order,"price":price,"fee":fee,"gross":gross,"quote_time":bar["quote_time"]})
    state["pending"] = []
    market_value = 0
    for symbol,pos in list(state["positions"].items()):
        if pos["quantity"] == 0:
            del state["positions"][symbol]
            continue
        bar = bars.get(symbol)
        if bar:
            pos.update(last_price=bar["price"],quote_time=bar["quote_time"])
        else:
            events.append({"type":"stale_price","symbol":symbol,"message":"缺少有效报价，保留上次估值"})
        market_value += pos["quantity"]*pos["last_price"]
    state["equity"] = round(state["cash"]+market_value,2)
    state["peak"] = max(state["peak"],state["equity"])
    state["max_drawdown"] = max(state["max_drawdown"],1-state["equity"]/state["peak"])
    state.update(last_date=date,last_timestamp=timestamp,last_slot=slot)
    if not math.isfinite(state["equity"]):
        raise ValueError("Nonfinite account value")
    return state,events
