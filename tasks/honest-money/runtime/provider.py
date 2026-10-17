"""Unauthenticated public Tencent quotes and unadjusted daily references. No paid API or token."""
import datetime as dt
import json
import math
import re
import time
import urllib.parse
import urllib.request
from .clock import now,parse,market_slot,snapshot_path,SHANGHAI
from .common import ROOT,read,write

def tencent_symbol(symbol):
    if not re.fullmatch(r"\d{6}\.(SH|SZ)",symbol):
        raise ValueError(f"Unsupported stock code: {symbol}")
    code,exchange=symbol.split(".")
    return exchange.lower()+code

class Tencent:
    def request(self,url,encoding="utf-8"):
        for attempt in range(3):
            try:
                request=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0","Referer":"https://gu.qq.com/"})
                with urllib.request.urlopen(request,timeout=20) as response:
                    return response.read().decode(encoding)
            except (OSError,UnicodeError):
                if attempt==2:
                    raise
                time.sleep(attempt+1)

    def quotes(self,universe):
        codes=",".join(tencent_symbol(symbol) for symbol in universe)
        text=self.request("https://qt.gtimg.cn/q="+codes,"gb18030")
        return parse_quotes(text)

    def previous_close(self,symbol,date):
        code=tencent_symbol(symbol)
        params=urllib.parse.urlencode({"param":f"{code},day,,,10,"})
        urls=["https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?"+params,
              "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?"+params]
        error=None
        for url in urls:
            try:
                payload=json.loads(self.request(url))
                if payload.get("code")!=0:
                    raise ValueError("Unadjusted daily endpoint returned an error")
                # Accept only 'day'; never silently substitute adjusted qfqday/hfqday data.
                rows=payload.get("data",{}).get(code,{}).get("day",[])
                prior=sorted(row for row in rows if len(row)>=3 and row[0]<date)
                if not prior:
                    raise ValueError(f"No previous unadjusted close for {symbol}")
                value=float(prior[-1][2])
                if not math.isfinite(value) or value<=0:
                    raise ValueError("Invalid reference close")
                return {"date":prior[-1][0],"close":value}
            except (OSError,ValueError,KeyError,TypeError) as exc:
                error=exc
        raise ValueError(f"Could not get reference for {symbol}: {error}")

def parse_quotes(text):
    quotes=[]
    for api_code,payload in re.findall(r'v_((?:sh|sz)\d{6})="([^"\r\n]*)";',text):
        fields=payload.split("~")
        if len(fields)<49 or fields[2]!=api_code[2:]:
            continue
        try:
            stamp=dt.datetime.strptime(fields[30],"%Y%m%d%H%M%S").replace(tzinfo=SHANGHAI).isoformat()
            # Composite quote carries turnover in yuan; other two documented-format fields are 10k yuan.
            composite=fields[35].split("/")
            if len(composite)>=3:
                amount=float(composite[2])
            elif len(fields)>57 and fields[57]:
                amount=float(fields[57])*10000
            else:
                amount=float(fields[37])*10000
            quote={"symbol":api_code[2:]+"."+api_code[:2].upper(),"price":float(fields[3]),"close":float(fields[3]),"open":float(fields[5]),"high":float(fields[33]),"low":float(fields[34]),"pre_close":float(fields[4]),"vol":float(fields[6])*100,"amount":amount,"quote_time":stamp,"up_limit":float(fields[47]),"down_limit":float(fields[48])}
            if any(not math.isfinite(v) or (v<0 if k in ("vol","amount") else v<=0) for k,v in quote.items() if isinstance(v,(int,float))):
                continue
            if not quote["down_limit"]<=quote["price"]<=quote["up_limit"]:
                continue
            quotes.append(quote)
        except (ValueError,IndexError):
            continue
    if not quotes:
        raise ValueError("Public quote response has no valid timestamped prices and limits")
    return quotes

def fetch_market(captured_at=None):
    explicit_clock=captured_at is not None
    captured_at=captured_at or now()
    slot=market_slot(captured_at)
    if slot is None:
        print("Outside trading window; no account changes")
        return None
    config=read(ROOT/"environment.json")
    path=snapshot_path(ROOT,slot)
    if path.exists():
        return slot
    api=Tencent()
    quotes=api.quotes(config["universe"])
    observed_at=captured_at if explicit_clock else now()
    if market_slot(observed_at)!=slot:
        raise ValueError("Acquisition crossed a ten-minute boundary; retry the new slot")
    date=observed_at.date().isoformat()
    today=[q for q in quotes if parse(q["quote_time"]).date().isoformat()==date]
    if not today:
        if all(parse(q["quote_time"]).date().isoformat()<date for q in quotes):
            print("Quotes are from an earlier date (closed market or source not updated); no new session")
            return None
        raise ValueError("Public source returned future-dated quotes")
    fresh=[q for q in today if 0<=(observed_at-parse(q["quote_time"])).total_seconds()<=config["max_quote_age_seconds"]]
    if not fresh:
        raise ValueError("No fresh intraday quotes; refusing to advance accounts")
    reference_path=ROOT/f"data/reference/{date}.json"
    reference=read(reference_path) if reference_path.exists() else {"source":"tencent/unadjusted-day","stocks":{}}
    if reference.get("source")!="tencent/unadjusted-day" or not isinstance(reference.get("stocks"),dict):
        reference={"source":"tencent/unadjusted-day","stocks":{}}
    bars,unavailable={},{}
    for quote in fresh:
        symbol=quote["symbol"]
        if symbol not in config["universe"]:
            continue
        if symbol not in reference["stocks"]:
            reference["stocks"][symbol]=api.previous_close(symbol,date)
        bar={key:value for key,value in quote.items() if key!="symbol"}
        bar["reference_close"]=reference["stocks"][symbol]["close"]
        bars[symbol]=bar
    for symbol in config["universe"]:
        if symbol not in bars:
            unavailable[symbol]="Missing, stale, suspended or invalid public quote"
    if not bars:
        raise ValueError("No valid quotes for configured universe")
    write(reference_path,reference)
    write(path,{"schema_version":2,"slot":slot,"date":date,"as_of":observed_at.isoformat(),"source":"tencent/public-quote","volume_unit":"shares (cumulative today)","bars":bars,"unavailable":unavailable})
    return slot
