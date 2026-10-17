import importlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from canvas.common import write,read
from test_trading_engine import PLUGIN,CONFIG,clock,SYMBOL

provider=importlib.import_module(PLUGIN.__name__+".provider")
QUOTE=(Path(__file__).parent/"fixtures/tencent-quote.txt").read_text(encoding="utf-8")

class TradingProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);write(self.root/"environment.json",CONFIG)
        p=patch.object(provider,"ROOT",self.root);p.start();self.addCleanup(p.stop)
        self.stamp=clock.parse("2026-10-19T09:41:00+08:00")
        self.quotes=provider.parse_quotes(QUOTE.replace("20261016161500","20261019094059"))

    def api(self,mock):
        mock.return_value.quotes.return_value=self.quotes
        mock.return_value.previous_close.return_value={"date":"2026-10-16","close":11.41}

    def test_public_quote_parser_preserves_price_time_limits_and_units(self):
        quote=provider.parse_quotes(QUOTE)[0]
        self.assertEqual(quote["symbol"],SYMBOL)
        self.assertEqual(quote["price"],11.5)
        self.assertEqual(quote["quote_time"],"2026-10-16T16:15:00+08:00")
        self.assertEqual(quote["vol"],111185100)
        self.assertEqual(quote["amount"],1281599063)
        self.assertEqual((quote["up_limit"],quote["down_limit"]),(12.55,10.27))

    def test_capture_needs_no_credentials_and_deduplicates_slot(self):
        with patch.dict("os.environ",{},clear=True),patch.object(provider,"Tencent") as api:
            self.api(api);slot=provider.fetch_market(self.stamp)
            snapshot=read(clock.snapshot_path(self.root,slot))
            self.assertEqual(snapshot["source"],"tencent/public-quote")
            self.assertEqual(snapshot["as_of"],self.stamp.isoformat())
            self.assertEqual(snapshot["bars"][SYMBOL]["reference_close"],11.41)
            self.assertNotIn("adj_factor",snapshot["bars"][SYMBOL])
            self.assertEqual(provider.fetch_market(self.stamp),slot)
            self.assertEqual(api.return_value.quotes.call_count,1)

    def test_previous_day_reference_is_cached_across_intraday_captures(self):
        with patch.object(provider,"Tencent") as api:
            self.api(api);provider.fetch_market(self.stamp)
            self.quotes[0]["quote_time"]="2026-10-19T09:50:59+08:00"
            provider.fetch_market(clock.parse("2026-10-19T09:51:00+08:00"))
            self.assertEqual(api.return_value.previous_close.call_count,1)

    def test_legacy_reference_cache_is_refreshed_without_credentials(self):
        write(self.root/"data/reference/2026-10-19.json",{"closes":{SYMBOL:11.41},"factors":{SYMBOL:1}})
        with patch.dict("os.environ",{},clear=True),patch.object(provider,"Tencent") as api:
            self.api(api)
            slot=provider.fetch_market(self.stamp)
            self.assertTrue(slot)
            self.assertEqual(api.return_value.previous_close.call_count,1)
        self.assertEqual(read(self.root/"data/reference/2026-10-19.json")["source"],"tencent/unadjusted-day")

    def test_old_quote_date_does_not_create_holiday_session(self):
        with patch.object(provider,"Tencent") as api:
            self.api(api);api.return_value.quotes.return_value=provider.parse_quotes(QUOTE)
            self.assertIsNone(provider.fetch_market(self.stamp))
            self.assertFalse(api.return_value.previous_close.called)

    def test_stale_quotes_never_advance_accounts(self):
        self.quotes[0]["quote_time"]="2026-10-19T09:00:00+08:00"
        with patch.object(provider,"Tencent") as api:
            self.api(api)
            with self.assertRaisesRegex(ValueError,"No fresh"):provider.fetch_market(self.stamp)

    def test_malformed_or_missing_limits_are_not_guessed(self):
        for text in ("v_sz000001=\"bad\";",QUOTE.replace("~12.55~10.27","~~")):
            with self.assertRaisesRegex(ValueError,"no valid"):provider.parse_quotes(text)

    def test_reference_only_accepts_unadjusted_daily_rows(self):
        api=provider.Tencent()
        payload='{"code":0,"data":{"sz000001":{"qfqday":[["2026-10-16","10","11"]]}}}'
        with patch.object(api,"request",return_value=payload):
            with self.assertRaisesRegex(ValueError,"reference"):api.previous_close(SYMBOL,"2026-10-19")

    def test_lunch_and_weekend_skip_without_http(self):
        for stamp in ("2026-10-19T12:00:00+08:00","2026-10-17T10:00:00+08:00"):
            with patch.object(provider,"Tencent") as api:
                self.assertIsNone(provider.fetch_market(clock.parse(stamp)));self.assertFalse(api.called)
