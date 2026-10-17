import json
import math
import statistics
import sys
from datetime import datetime, timedelta, timezone

SCHEMA = 1
TZ = timezone(timedelta(hours=8))
BANKS = {"600036.SH", "000001.SZ", "601398.SH"}
KEEP_DAYS = 65


def number(value, default=0.0):
    if isinstance(value, bool):
        return default
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError, OverflowError):
        return default


def integer(value, default=0):
    n = number(value, float(default))
    return int(n) if n == math.trunc(n) else default


def stamp(value):
    try:
        dt = datetime.fromisoformat(value)
        return dt.astimezone(TZ) if dt.tzinfo is not None else None
    except (TypeError, ValueError, OverflowError):
        return None


def date_string(value):
    try:
        return (
            isinstance(value, str)
            and len(value) == 10
            and datetime.strptime(value, "%Y-%m-%d").date().isoformat() == value
        )
    except ValueError:
        return False


def in_session(dt):
    minute = dt.hour * 60 + dt.minute
    return dt.weekday() < 5 and (
        570 <= minute <= 690 or 780 <= minute <= 900
    )


def quote(bar, observed, max_age):
    if not isinstance(bar, dict):
        return None
    qt = stamp(bar.get("quote_time"))
    p = number(bar.get("price"))
    lo = number(bar.get("down_limit"))
    hi = number(bar.get("up_limit"))
    if (
        qt is None
        or qt.date() != observed.date()
        or not in_session(qt)
        or not 0 <= (observed - qt).total_seconds() <= max_age
        or p <= 0
        or number(bar.get("vol")) <= 0
        or not 0 < lo < hi
        or p < lo - 0.011
        or p > hi + 0.011
    ):
        return None
    return {
        "p": p,
        "lo": lo,
        "hi": hi,
        "qt": qt,
        "pre": number(bar.get("pre_close")),
        "ref": number(bar.get("reference_close")),
    }


def state_from(raw, universe, today):
    # 只解释已知辅助状态格式；权威账户独立于 memory。
    old = (
        raw
        if isinstance(raw, dict) and raw.get("strategy_schema") == SCHEMA
        else {}
    )
    state = {
        "strategy_schema": SCHEMA,
        "symbols": {},
        "trails": {},
        "bans": {},
        "risk": {"next_dd": 0.12, "cooldown": 0},
        "day": "",
        "last_as_of": "",
        "last_slot": "",
        "rebalance_date": "",
        "revision": "",
    }
    for key in ("day", "rebalance_date"):
        v = old.get(key)
        if date_string(v) and v <= today:
            state[key] = v
    for key in ("last_as_of", "last_slot"):
        if stamp(old.get(key)) is not None:
            state[key] = old[key]

    old_symbols = old.get("symbols", {})
    old_trails = old.get("trails", {})
    if not isinstance(old_symbols, dict):
        old_symbols = {}
    if not isinstance(old_trails, dict):
        old_trails = {}

    for symbol in universe:
        old_bans = old.get("bans", {})
        if isinstance(old_bans, dict):
            remaining = max(0, min(5, integer(old_bans.get(symbol))))
            if remaining:
                state["bans"][symbol] = remaining

        item = old_symbols.get(symbol, {})
        item = item if isinstance(item, dict) else {}
        reset = item.get("reset_on", "")
        reset = reset if date_string(reset) and reset <= today else ""
        rows = {}
        source = item.get("days", [])
        for row in source[-KEEP_DAYS * 2:] if isinstance(source, list) else []:
            if not isinstance(row, list) or len(row) != 3:
                continue
            d, p, qt = row[0], number(row[1]), stamp(row[2])
            if (
                not date_string(d)
                or not reset <= d <= today
                or p <= 0
                or qt is None
                or qt.date().isoformat() != d
                or not in_session(qt)
                or qt.hour * 60 + qt.minute < 890
            ):
                continue
            if d not in rows or qt > stamp(rows[d][2]):
                rows[d] = [d, p, qt.isoformat()]
        state["symbols"][symbol] = {
            "days": [rows[d] for d in sorted(rows)][-KEEP_DAYS:],
            "reset_on": reset,
        }

        trail = old_trails.get(symbol, {})
        if isinstance(trail, dict) and number(trail.get("peak")) > 0:
            tag = trail.get("tag", "")
            state["trails"][symbol] = {
                "peak": number(trail["peak"]),
                "tag": tag[:100] if isinstance(tag, str) else "",
            }

    risk = old.get("risk", {})
    if isinstance(risk, dict):
        state["risk"] = {
            "next_dd": min(
                2.0, max(0.12, number(risk.get("next_dd"), 0.12))
            ),
            "cooldown": max(0, min(10, integer(risk.get("cooldown")))),
        }
    return state


def finish(orders, state, message):
    # 按协议默认 JSON 序列化长度检查，额外留出余量。
    while len(json.dumps(state, allow_nan=False)) > 62000:
        candidates = [
            v for v in state["symbols"].values() if v["days"]
        ]
        if not candidates:
            state = {"strategy_schema": SCHEMA}
            break
        min(
            candidates, key=lambda v: v["days"][0][0]
        )["days"].pop(0)
    return {
        "orders": orders[:50],
        "memory": state,
        "commentary": message[:1000],
    }


def decide(data):
    env = data.get("environment", {})
    account = data.get("account", {})
    now, slot = stamp(data.get("as_of")), stamp(data.get("slot"))
    if (
        data.get("schema_version") != 2
        or not isinstance(env, dict)
        or not isinstance(account, dict)
        or now is None
        or slot is None
    ):
        return {
            "orders": [],
            "memory": {},
            "commentary": "输入协议无效，停止新委托。",
        }

    universe = sorted({
        s for s in env.get("universe", []) if isinstance(s, str)
    })
    today = now.date().isoformat()
    state = state_from(
        data.get("memory", account.get("memory", {})), universe, today
    )
    previous = stamp(state["last_as_of"])
    previous_slot = stamp(state["last_slot"])
    if (
        (previous is not None and now <= previous)
        or (previous_slot is not None and slot <= previous_slot)
    ):
        return finish(
            [], state, "重复或倒序轮次，保留状态，不重复委托。"
        )
    if (
        data.get("execution") != "next_observed_fresh_quote"
        or env.get("schema_version") != 2
        or not in_session(slot)
        or now.date() != slot.date()
        or now < slot
    ):
        return finish(
            [], state, "执行模式或采样槽位不符合协议，停止新委托。"
        )

    state["last_as_of"] = now.isoformat()
    state["last_slot"] = slot.isoformat()
    state["revision"] = str(data.get("revision", ""))[:120]
    if today != state["day"]:
        if state["day"]:
            state["risk"]["cooldown"] = max(
                0, state["risk"]["cooldown"] - 1
            )
            state["bans"] = {
                s: n - 1 for s, n in state["bans"].items() if n > 1
            }
        state["day"] = today

    max_age = max(
        0.0, number(env.get("max_quote_age_seconds"), 600)
    )
    history = data.get("history", [])
    snapshots = []
    for snap in history if isinstance(history, list) else []:
        if not isinstance(snap, dict):
            continue
        observed = stamp(snap.get("as_of"))
        if (
            observed is not None
            and observed <= now
            and isinstance(snap.get("bars"), dict)
        ):
            snapshots.append((observed, snap))
    snapshots.sort(key=lambda x: x[0])

    current = {}
    for observed, snap in snapshots:
        for symbol in universe:
            q = quote(snap["bars"].get(symbol), observed, max_age)
            if q is None:
                continue
            d = q["qt"].date().isoformat()
            item = state["symbols"][symbol]

            # 参考价存在可见断点时，不跨断点比较未复权价格。
            if (
                q["pre"] > 0
                and q["ref"] > 0
                and abs(q["pre"] / q["ref"] - 1) >= 0.005
            ):
                if d > item["reset_on"]:
                    item["reset_on"] = d
                    item["days"] = [
                        r for r in item["days"] if r[0] >= d
                    ]

            if (
                d >= item["reset_on"]
                and q["qt"].hour * 60 + q["qt"].minute >= 890
            ):
                rows = {r[0]: r for r in item["days"]}
                row = [d, q["p"], q["qt"].isoformat()]
                if d not in rows or q["qt"] > stamp(rows[d][2]):
                    rows[d] = row
                item["days"] = [
                    rows[k] for k in sorted(rows)
                ][-KEEP_DAYS:]

        # 当前行情只取最新快照，缺失代码不从旧快照补齐。
        if observed == snapshots[-1][0]:
            current = {
                s: q
                for s in universe
                if (
                    q := quote(snap["bars"].get(s), now, max_age)
                ) is not None
            }

    positions = account.get("positions", {})
    positions = positions if isinstance(positions, dict) else {}
    equity = number(account.get("equity"))
    cash = number(account.get("cash"))
    peak = max(equity, number(account.get("peak")))
    dd = max(0.0, 1 - equity / peak) if peak > 0 else 1.0
    risk = state["risk"]
    if dd < 0.06:
        risk["next_dd"] = 0.12
    if dd >= risk["next_dd"]:
        risk["next_dd"] = min(2.0, dd + 0.04)
        risk["cooldown"] = 10
    liquidate = equity <= 0 or risk["cooldown"] > 0

    lot = integer(env.get("lot_size"), 100)
    if not 1 <= lot <= 1000000000:
        return finish([], state, "无效交易单位，停止新委托。")
    rate = max(0.0, number(env.get("commission_rate"), 0.0003))
    minimum = max(0.0, number(env.get("minimum_commission"), 5))
    tax = max(0.0, number(env.get("sell_tax_rate"), 0.0005))
    slip = max(0.0, number(env.get("slippage_bps"), 5)) / 10000
    max_debt = max(0.0, number(env.get("max_debt"), 200000))

    metrics, stale = {}, False
    gross = 0.0
    holdings = {}
    for symbol, pos in positions.items():
        if not isinstance(pos, dict):
            continue
        qty = max(0, integer(pos.get("quantity")))
        if not qty:
            continue
        q = current.get(symbol)
        valuation = (
            q["p"] if q else max(0.0, number(pos.get("last_price")))
        )
        gross += qty * valuation
        stale = stale or q is None or valuation <= 0
        holdings[symbol] = (
            qty,
            max(0, min(qty, integer(pos.get("sellable")))),
            pos,
        )

    for symbol in universe:
        closes = [
            r[1]
            for r in state["symbols"][symbol]["days"]
            if r[0] < today
        ]
        if len(closes) >= 21:
            prices = closes[-21:]
            returns = [
                prices[i] / prices[i - 1] - 1 for i in range(1, 21)
            ]
            vol = max(0.008, statistics.pstdev(returns))
            metrics[symbol] = {
                "ma": statistics.fmean(prices[-20:]),
                "m20": prices[-1] / prices[0] - 1,
                "m5": prices[-1] / prices[-6] - 1,
                "vol": vol,
            }

    # 退出数量来自本轮账户，不把历史委托当作成交。
    exits = {}
    for symbol, (qty, sellable, pos) in holdings.items():
        if symbol not in universe:
            continue
        q = current.get(symbol)
        item = state["symbols"][symbol]
        tag = (
            item["reset_on"] + "/" + str(pos.get("reconciled_on", ""))
        )[:100]
        trail = state["trails"].get(symbol, {})
        high = (
            number(trail.get("peak"))
            if trail.get("tag") == tag else 0.0
        )
        if q:
            high = max(high, q["p"])
            state["trails"][symbol] = {"peak": high, "tag": tag}

        if liquidate:
            exits[symbol] = "组合回撤冷却或净资产非正，退出可卖持仓"
        elif q:
            p, cost = q["p"], number(pos.get("cost"))
            m = metrics.get(symbol)
            if cost > 0 and p <= cost * 0.92:
                exits[symbol] = "现价较账户成本回撤至少8%"
            elif high > 0 and p <= high * 0.90:
                exits[symbol] = "现价较持仓期间可见高点回撤至少10%"
            elif m and (
                p < m["ma"] * 0.98 or m["m20"] < -0.03
            ):
                exits[symbol] = (
                    "价格跌破20日采样均值2%或20日动量低于-3%"
                )

    state["trails"] = {
        s: t for s, t in state["trails"].items() if s in holdings
    }
    for symbol in exits:
        state["bans"][symbol] = 5

    if account.get("pending"):
        return finish(
            [], state, "仍有未结旧委托，等待账户结算后重新计算。"
        )

    orders = []
    sold = {}

    def sell(symbol, requested, reason):
        if (
            symbol not in holdings
            or symbol not in current
            or symbol not in universe
        ):
            return 0
        q = current[symbol]
        if q["p"] <= q["lo"] + 0.001:
            return 0
        available = holdings[symbol][1] - sold.get(symbol, 0)
        amount = (
            min(max(0, requested), available, 1000000000) // lot * lot
        )
        if amount <= 0 or len(orders) >= 50:
            return 0
        orders.append({
            "symbol": symbol,
            "side": "sell",
            "quantity": amount,
            "reason": reason,
        })
        sold[symbol] = sold.get(symbol, 0) + amount
        return amount

    for symbol in sorted(exits):
        sell(symbol, holdings[symbol][0], exits[symbol])

    if cash < 0:
        # 按当日跌停价保守估计回款；负现金期间不买入。
        need = -cash + max(0.0, equity) * 0.05
        for symbol, amount in sold.items():
            value = round(current[symbol]["lo"] * amount, 2)
            need -= value - round(
                max(minimum, value * rate) + value * tax, 2
            )
        for symbol in sorted(
            holdings,
            key=lambda s: holdings[s][0] * number(
                holdings[s][2].get("last_price")
            ),
            reverse=True,
        ):
            if need <= 0:
                break
            q = current.get(symbol)
            if not q:
                continue
            unit = max(
                0.01, q["lo"] * max(0.0, 1 - rate - tax)
            )
            request = math.ceil(
                (need + minimum) / (unit * lot)
            ) * lot
            amount = sell(
                symbol, request, "负现金去杠杆，卖出回款自动偿债"
            )
            if amount:
                value = round(q["lo"] * amount, 2)
                need -= value - round(
                    max(minimum, value * rate) + value * tax, 2
                )
        return finish(
            orders, state,
            f"负现金{cash:.2f}，优先偿债；卖单{len(orders)}笔。",
        )

    if exits or liquidate:
        return finish(
            orders, state,
            f"风控退出{len(exits)}只，卖单{len(orders)}笔；"
            f"冷却剩余{risk['cooldown']}个已观察交易日期。",
        )

    minute = slot.hour * 60 + slot.minute
    if (
        state["rebalance_date"] == today
        or not 600 <= minute <= 880
        or not in_session(now)
    ):
        return finish(
            [], state, "等待每日调仓窗口；本轮风控检查完成。"
        )

    ready = [
        s for s in universe if s in metrics and s in current
    ]
    required = min(4, len(universe))
    if not universe or len(ready) < required or stale:
        return finish(
            [], state,
            f"可用趋势样本{len(ready)}/{required}，或持仓报价缺失；"
            "暂停普通调仓。",
        )

    positive = [
        s for s in ready
        if metrics[s]["m20"] > 0
        and current[s]["p"] >= metrics[s]["ma"]
    ]
    breadth = len(positive) / len(universe)
    exposure = (
        0.75 if breadth >= 0.60
        else (0.40 if breadth >= 0.40 else 0.0)
    )
    if dd >= 0.06:
        exposure = min(exposure, 0.25)

    eligible = []
    for s in positive:
        q, m = current[s], metrics[s]
        entry_ok = (
            q["p"] < q["hi"] - 0.001
            and (q["pre"] <= 0 or q["p"] <= q["pre"] * 1.04)
        )
        if (
            m["m20"] >= 0.02
            and m["m5"] > 0
            and m["vol"] <= 0.04
            and not state["bans"].get(s)
            and (s in holdings or entry_ok)
        ):
            eligible.append(s)

    eligible.sort(
        key=lambda s: (-metrics[s]["m20"] / metrics[s]["vol"], s)
    )
    selected = eligible[:4]
    weights = {}
    denominator = sum(1 / metrics[s]["vol"] for s in selected)
    for s in selected:
        weights[s] = min(
            0.25, exposure / (metrics[s]["vol"] * denominator)
        )
    bank_weight = sum(weights.get(s, 0) for s in BANKS)
    if bank_weight > 0.40:
        for s in BANKS & weights.keys():
            weights[s] *= 0.40 / bank_weight

    targets = {
        s: int(
            max(0.0, equity) * w / current[s]["p"] / lot
        ) * lot
        for s, w in weights.items()
    }
    minimum_trade = max(3000.0, max(0.0, equity) * 0.04)
    for s, (qty, sellable, pos) in sorted(holdings.items()):
        if s not in current or s not in universe:
            continue
        excess = qty - targets.get(s, 0)
        if excess > 0 and (
            targets.get(s, 0) == 0
            or excess * current[s]["p"] >= minimum_trade
        ):
            sell(
                s, excess,
                "每日目标仓位下降或未入选，按可卖整手减仓",
            )
    if orders:
        return finish(
            orders, state,
            "先减仓，待下一轮权威账户确认后再评估买入。",
        )

    # T+1、跌停或整手约束阻止的减仓不能视为已经完成。
    blocked = any(
        qty > targets.get(s, 0)
        and (
            targets.get(s, 0) == 0
            or (
                qty - targets.get(s, 0)
            ) * current[s]["p"] >= minimum_trade
        )
        for s, (qty, _, _) in holdings.items()
        if s in current and s in universe
    )
    if blocked:
        return finish(
            [], state,
            "目标减仓受T+1、整手或跌停限制，等待退出后再买入。",
        )

    reserve = max(0.0, equity) * 0.05
    budget = max(
        0.0, min(cash - reserve, cash + max_debt)
    )
    room = max(0.0, max(0.0, equity) * exposure - gross)

    for s in selected:
        q = current[s]
        if (
            q["p"] >= q["hi"] - 0.001
            or (q["pre"] > 0 and q["p"] > q["pre"] * 1.04)
        ):
            continue
        qty = holdings.get(s, (0, 0, {}))[0]
        wanted = max(0, targets.get(s, 0) - qty) // lot * lot

        # 使用行情源的当日涨停价预算，不自行推算涨停价。
        stress_price = max(
            q["hi"], round(q["p"] * (1 + slip), 2)
        )
        cap = min(budget, room, max(0.0, equity) * 0.20)
        available = max(
            0.0, min(cap - minimum, cap / (1 + rate))
        )
        amount = min(
            wanted,
            int(available / stress_price / lot) * lot,
            1000000000 // lot * lot,
        )
        if amount <= 0 or amount * q["p"] < minimum_trade:
            continue
        value = round(stress_price * amount, 2)
        cost = value + round(max(minimum, value * rate), 2)
        if cost > cap or len(orders) >= 50:
            continue
        orders.append({
            "symbol": s,
            "side": "buy",
            "quantity": amount,
            "reason": (
                f"20日动量{metrics[s]['m20']:.1%}、5日动量为正，"
                f"组合目标敞口{exposure:.0%}"
            ),
        })
        budget -= cost
        room -= cost

    state["rebalance_date"] = today
    return finish(
        orders, state,
        f"趋势可用{len(ready)}只，宽度{breadth:.0%}，"
        f"目标敞口{exposure:.0%}；买单{len(orders)}笔，"
        "预留现金且不主动借款。",
    )


def main():
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            raise ValueError("object required")
        output = decide(data)
        # 先完整序列化，再一次输出，避免留下半个 JSON 对象。
        encoded = json.dumps(
            output,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
    except Exception as exc:
        print(
            "strategy fallback: " + type(exc).__name__,
            file=sys.stderr,
        )
        encoded = json.dumps(
            {
                "orders": [],
                "memory": {},
                "commentary": (
                    "输入或计算异常，未提交新委托；"
                    "辅助状态将在后续有效输入重建。"
                ),
            },
            ensure_ascii=False,
            allow_nan=False,
        )
    sys.stdout.write(encoded + "\n")


if __name__ == "__main__":
    main()