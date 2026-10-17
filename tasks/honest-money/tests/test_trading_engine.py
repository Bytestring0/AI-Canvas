"""Synthetic task fixtures; never copied to actual market data or submissions."""
import copy
import importlib
import unittest
from canvas.registry import tasks,load_runtime

PLUGIN=load_runtime(next(t for t in tasks() if t["id"]=="honest-money"))
engine=importlib.import_module(PLUGIN.__name__+".engine")
clock=importlib.import_module(PLUGIN.__name__+".clock")
CONFIG=PLUGIN.read(PLUGIN.ROOT/"environment.json")
SYMBOL="000001.SZ"

def snapshot(timestamp="2026-10-19T09:40:00+08:00",**overrides):
    bar={"price":10,"open":9.9,"high":10.2,"low":9.8,"close":10,"pre_close":10,"reference_close":10,"vol":10000,"amount":100000,"up_limit":11,"down_limit":9,"adj_factor":1,"quote_time":timestamp}
    bar.update(overrides)
    return {"schema_version":2,"slot":clock.market_slot(clock.parse(timestamp)),"as_of":timestamp,"date":timestamp[:10],"bars":{SYMBOL:bar}}

def order(side="buy",quantity=100):
    return {"symbol":SYMBOL,"side":side,"quantity":quantity,"revision":"v1","submitted_at":"2026-10-19T09:30:01+08:00"}

class TradingEngineTests(unittest.TestCase):
    def test_empty_account_has_no_invented_fills(self):
        state,events=engine.settle(engine.initial(CONFIG),snapshot(),CONFIG)
        self.assertEqual(state["cash"],100000);self.assertFalse(events)

    def test_matching_uses_new_quote_not_daily_open(self):
        state=engine.initial(CONFIG);state["pending"]=[order()];before=copy.deepcopy(state)
        result,events=engine.settle(state,snapshot(price=10.5),CONFIG)
        fill=next(e for e in events if e["type"]=="filled")
        self.assertGreaterEqual(fill["price"],10.5);self.assertEqual(fill["fee"],5)
        self.assertEqual(state,before);self.assertEqual(result["positions"][SYMBOL]["sellable"],0)

    def test_t_plus_one_is_not_reset_every_ten_minutes(self):
        state=engine.initial(CONFIG);state["pending"]=[order()]
        state,_=engine.settle(state,snapshot(),CONFIG)
        state["pending"]=[order("sell")]
        state,events=engine.settle(state,snapshot("2026-10-19T09:50:00+08:00"),CONFIG)
        self.assertTrue(any("T+1" in e.get("message","") for e in events))
        self.assertEqual(state["positions"][SYMBOL]["sellable"],0)
        state["pending"]=[order("sell")]
        state,events=engine.settle(state,snapshot("2026-10-20T09:40:00+08:00"),CONFIG)
        self.assertFalse(state["positions"]);self.assertTrue(any(e["type"]=="filled" for e in events))

    def test_same_or_older_quote_cannot_fill(self):
        state=engine.initial(CONFIG);state["pending"]=[order()]
        _,events=engine.settle(state,snapshot(quote_time=order()["submitted_at"]),CONFIG)
        self.assertEqual(events[0]["type"],"rejected")

    def test_debt_allowed_and_capped(self):
        state=engine.initial(CONFIG);state["pending"]=[order(quantity=20000),order(quantity=20000)]
        result,events=engine.settle(state,snapshot(),CONFIG)
        self.assertLess(result["cash"],0);self.assertEqual(events[-1]["type"],"rejected")

    def test_interest_uses_elapsed_seconds_with_subcent_carry(self):
        state=engine.initial(CONFIG);state.update(cash=-1000,last_timestamp="2026-10-19T09:30:00+08:00",last_slot="2026-10-19T09:30:00+08:00",last_date="2026-10-19")
        state,_=engine.settle(state,snapshot(),CONFIG)
        self.assertEqual(state["cash"],-1000);self.assertGreater(state["interest_remainder"],0)
        state,_=engine.settle(state,snapshot("2026-10-19T09:50:00+08:00"),CONFIG)
        self.assertGreater(state["interest_remainder"],.002)

    def test_interest_includes_weekend(self):
        state=engine.initial(CONFIG);state.update(cash=-10000,last_timestamp="2026-10-16T15:00:00+08:00",last_slot="2026-10-16T15:00:00+08:00",last_date="2026-10-16")
        result,events=engine.settle(state,snapshot("2026-10-19T09:30:00+08:00"),CONFIG)
        self.assertGreater(events[0]["amount"],4);self.assertLess(result["cash"],-10004)

    def test_duplicate_slot_cannot_settle(self):
        state,_=engine.settle(engine.initial(CONFIG),snapshot(),CONFIG)
        with self.assertRaisesRegex(ValueError,"once"):engine.settle(state,snapshot(),CONFIG)

    def test_gap_is_logged_without_extra_trades(self):
        state,_=engine.settle(engine.initial(CONFIG),snapshot(),CONFIG)
        state,events=engine.settle(state,snapshot("2026-10-19T10:30:00+08:00"),CONFIG)
        self.assertEqual(state["cash"],100000);self.assertTrue(any(e["type"]=="gap" for e in events))

    def test_limits_and_short_selling_rejected(self):
        for ord,bar in ((order(),{"price":11}),(order("sell"),{})):
            state=engine.initial(CONFIG);state["pending"]=[ord]
            _,events=engine.settle(state,snapshot(**bar),CONFIG)
            self.assertEqual(events[0]["type"],"rejected")

    def test_order_schema(self):
        for values in ({"quantity":True},{"quantity":101},{"quantity":1.5},{"symbol":"BAD"}):
            with self.assertRaises(ValueError):engine.validate_orders([{**order(),**values}],CONFIG)

    def test_corporate_action_applies_once_per_day(self):
        state=engine.initial(CONFIG);state["pending"]=[order()];state,_=engine.settle(state,snapshot(),CONFIG)
        changed=snapshot("2026-10-20T09:40:00+08:00",pre_close=9.9)
        with self.assertRaisesRegex(ValueError,"Corporate action"):engine.settle(state,changed,CONFIG)
        action={"date":"2026-10-20","symbol":SYMBOL,"cash_per_share":.1,"quantity_multiplier":1,"reference":"synthetic test"}
        state,events=engine.settle(state,changed,CONFIG,[action]);cash=state["cash"]
        state,events=engine.settle(state,snapshot("2026-10-20T09:50:00+08:00",pre_close=9.9),CONFIG,[action])
        self.assertEqual(state["cash"],cash);self.assertFalse(any(e["type"]=="corporate_action" for e in events))
