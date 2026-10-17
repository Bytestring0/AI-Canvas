#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI Canvas 参赛策略：单文件、纯标准库、一次调用一次决策。

用法（由环境控制）：
    python -X utf8 -I -S /submission/strategy.py
stdin  读入一个完整 JSON 对象（协议 sampled-intraday-v2）
stdout 输出唯一一个 JSON 对象：{"orders": [...], "memory": {...}, "commentary": "..."}

设计摘要（详见 README.md）：
  * 只做多、不使用融券/衍生品；杠杆仅通过允许的负现金（借款）实现，默认几乎不加杠杆。
  * 由当日累计快照 + 跨日自建序列算出：中期动量（1/5/20 日）、日内动量、波动率、趋势。
  * 波动率目标仓位 + 组合回撤阶梯降险 + 单票止损/移动止损 + 信号反转退出。
  * T+1 严格遵守：只卖 account.positions[s].sellable，且记忆中当日买入的份额绝不卖出。
  * 退出信号每轮评估；建仓/再平衡每 ROTATE_EVERY 个交易日槽位评估一次，降低换手与费用。
  * 只在有合法信号时下单，否则空仓等待；输出永不抛异常（异常时返回空 orders）。
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import math
import sys

# ---------------------------------------------------------------------------
# 策略自身版本与参数（可通过 memory 迁移识别；不依赖固定 revision 字符串）
# ---------------------------------------------------------------------------

DEFAULT_REVISION = "trend-vol-v1"
STRATEGY_TAG = "trend_vol_sampled_v1"
MEMORY_SCHEMA = 1

MAX_POSITIONS = 4          # 最多同时持有的股票数（8 只受控池内集中持有的上限）
WEIGHT_CAP = 0.35          # 单票目标权重上限（占净资产）
DEFAULT_GROSS = 1.00       # 默认总多头敞口上限（≈不使用借款）
TARGET_VOL = 0.005         # 波动率目标常数：w_i ∝ TARGET_VOL / vol_i
VOL_FLOOR = 0.005          # 日波动率下限，避免低波动股票吃掉全部预算
VOL_CAP = 0.06             # 日波动率上限，避免高波动股票被压到 0 权重
VOL_WINDOW = 20            # 日收益波动率窗口
MAX_DAILY_MOVE = 0.15      # 过滤 |日收益| 过大的脏数据/异常
MAX_INTRADAY_MOVE = 0.105  # 过滤 |日内收益| 过大的异常
LIMIT_GUARD = 0.004        # 距离涨/跌停价 0.4% 以内视为“贴近涨跌停”，不买/优先卖
STOP_LOSS = -0.09          # 相对成本止损
TRAIL_STOP = -0.12         # 自持仓期最高价的移动止损
TAKE_PROFIT = 0.30         # 相对成本的止盈阈值（分批减半，仅在轮换槽位评估）
CRASH_EXIT_MOVE = -0.030   # 当日跌幅达到 3%：先减半（清仓线见 -4.5%）
EXIT_SCORE = -0.02         # 综合分低于此值退出
MIN_BUY_SCORE = 0.002      # 入选的最低综合分：约等于“确认 0.2% 以上的动量”才动用资金
INTRADAY_MIN_MOVE = 0.003  # 无跨日历史时，日内/槽内动量至少要有 0.3% 才允许建仓
SCORE_TILT_MIN = 0.60      # 分数对目标权重的倾斜下界（弱信号小仓）
SCORE_TILT_MAX = 1.30      # 分数对目标权重的倾斜上界（强信号相对大仓）
MIN_TRADE_DRIFT = 0.04     # 单笔调整的最小规模（占净资产），低于此值不交易以省佣金
ROTATE_EVERY = 3           # 每 N 个“新” 10 分钟槽位评估一次建仓/再平衡
MIN_QUOTE_MATCH = 2        # 自建日内序列所需的最少同轮快照数
SERIES_KEEP_DAYS = 80      # 自建日收益序列最多保留的交易日数
EXIT_COOLDOWN_DAYS = 2     # 止损后冷却交易日数
MAX_ORDERS = 50            # 协议上限
BUY_COST_BUFFER = 1.004    # 建仓估值缓冲（滑点+佣金）
MEMORY_BUDGET = 60000      # memory 序列化长度预算（协议上限 65536）

# 组合回撤阶梯：|max_drawdown| >= 阈值时把总敞口上限压到给定系数
DRAWDOWN_TIERS = ((0.28, 0.0), (0.22, 0.25), (0.15, 0.50), (0.08, 0.80))

WEEKDAY_CN = {0: "Mon", 1: "Tue", 2: "Wed", 3: "Thu", 4: "Fri", 5: "Sat", 6: "Sun"}


# ---------------------------------------------------------------------------
# 基础工具：时间解析 / 数值清洗
# ---------------------------------------------------------------------------

def parse_ts(value):
    """把带时区（或朴素）ISO 8601 字符串解析为 datetime；失败返回 None。"""
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    if len(text) >= 5 and text[-5] in "+-" and text[-4:].isdigit():  # +0800 -> +08:00
        text = text[:-2] + ":" + text[-2:]
    try:
        return _dt.datetime.fromisoformat(text)
    except Exception:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            return _dt.datetime.strptime(text, fmt)
        except Exception:
            continue
    return None


def safe_float(value, default=None):
    """只接受有限数值（拒绝 bool / NaN / inf / 字符串数字以外的脏值）。"""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        out = float(value)
    elif isinstance(value, str):
        try:
            out = float(value.strip())
        except Exception:
            return default
    else:
        return default
    if not math.isfinite(out):
        return default
    return out


def safe_int(value, default=None):
    num = safe_float(value, None)
    if num is None:
        return default
    if abs(num - round(num)) > 1e-9:
        return default
    return int(round(num))


def round_or_none(value, digits=6):
    if value is None:
        return None
    num = safe_float(value, None)
    if num is None:
        return None
    return round(num, digits)


def mean(values):
    return sum(values) / float(len(values)) if values else 0.0


def stdev(values):
    """样本标准差；不足 2 个样本返回 0。"""
    n = len(values)
    if n < 2:
        return 0.0
    mu = sum(values) / float(n)
    var = sum((v - mu) ** 2 for v in values) / float(n - 1)
    return math.sqrt(max(var, 0.0))


def median(values):
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return 0.5 * (ordered[mid - 1] + ordered[mid])


def clamp(value, low, high):
    return low if value < low else (high if value > high else value)


def norm_date(value):
    """把日期字段规范成 YYYY-MM-DD；失败返回 None。"""
    if not isinstance(value, str) or len(value) < 8:
        return None
    text = value.strip()[:10]
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        return text
    stamp = parse_ts(value)
    return stamp.strftime("%Y-%m-%d") if stamp else None


# ---------------------------------------------------------------------------
# 环境参数
# ---------------------------------------------------------------------------

def load_environment(raw):
    env = raw if isinstance(raw, dict) else {}

    def num(key, default, low=None):
        val = safe_float(env.get(key), default)
        if low is not None and val < low:
            val = default
        return val

    universe = []
    for item in env.get("universe") or []:
        if isinstance(item, str) and item.strip() and item.strip() not in universe:
            universe.append(item.strip())
    if not universe:
        universe = ["600519.SH", "601318.SH", "600036.SH", "000001.SZ",
                    "000333.SZ", "000651.SZ", "600900.SH", "601398.SH"]

    out = {
        "schema_version": safe_int(env.get("schema_version"), 2),
        "initial_cash": num("initial_cash", 100000.0, 0.0),
        "annual_debt_interest": num("annual_debt_interest", 0.06, 0.0),
        "max_debt": num("max_debt", 200000.0, 0.0),
        "commission_rate": num("commission_rate", 0.0003, 0.0),
        "minimum_commission": num("minimum_commission", 5.0, 0.0),
        "sell_tax_rate": num("sell_tax_rate", 0.0005, 0.0),
        "slippage_bps": num("slippage_bps", 5.0, 0.0),
        "lot_size": max(1, safe_int(env.get("lot_size"), 100) or 100),
        "universe": universe,
        "cadence_minutes": num("cadence_minutes", 10.0, 0.1),
        "history_points": max(1, safe_int(env.get("history_points"), 240) or 240),
        "max_quote_age_seconds": num("max_quote_age_seconds", 600.0, 1.0),
    }
    return out


# ---------------------------------------------------------------------------
# memory 读写与迁移
# ---------------------------------------------------------------------------

def load_memory(payload, top_level):
    """顶层 memory 优先；account.memory 作为兜底。两者内容本应一致。"""
    for cand in (top_level, payload.get("memory")):
        if isinstance(cand, dict) and cand:
            return cand
    if isinstance(top_level, dict):
        return top_level
    return {}


def mem_dict(memory, key):
    val = memory.get(key)
    return val if isinstance(val, dict) else {}


def load_price_series(memory):
    """读取自建日序列。兼容两种格式：
       新格式 {symbol: [[date, close, ref], ...]}；旧/未来格式 {symbol: [[date, close], ...]}。
    无法识别的条目直接丢弃，绝不让迁移失败影响本轮决策。"""
    raw = memory.get("series")
    out = {}
    if not isinstance(raw, dict):
        return out
    for symbol, rows in raw.items():
        if not isinstance(symbol, str) or not isinstance(rows, list):
            continue
        cleaned = {}
        for row in rows:
            if not isinstance(row, (list, tuple)) or len(row) < 2:
                continue
            date = norm_date(row[0])
            close = safe_float(row[1], None)
            if date is None or close is None or close <= 0:
                continue
            ref = safe_float(row[2], None) if len(row) > 2 else None
            if ref is not None and ref <= 0:
                ref = None
            cleaned[date] = (close, ref)
        if cleaned:
            out[symbol] = cleaned
    return out


def load_pos_state(memory):
    raw = memory.get("pos")
    out = {}
    if not isinstance(raw, dict):
        return out
    for symbol, item in raw.items():
        if not isinstance(symbol, str):
            continue
        entry = {}
        if isinstance(item, dict):
            entry["entry"] = safe_float(item.get("entry"), None)
            entry["peak"] = safe_float(item.get("peak"), None)
            entry["buy_date"] = norm_date(item.get("buy_date"))
            entry["entry_date"] = norm_date(item.get("entry_date"))
            entry["tw"] = safe_float(item.get("tw"), None)
        elif isinstance(item, (list, tuple)):
            entry["entry"] = safe_float(item[0], None) if len(item) > 0 else None
            entry["peak"] = safe_float(item[1], None) if len(item) > 1 else None
            entry["buy_date"] = norm_date(item[2]) if len(item) > 2 else None
            entry["entry_date"] = None
            entry["tw"] = safe_float(item[3], None) if len(item) > 3 else None
        else:
            continue
        entry["last_seen"] = norm_date(item.get("seen")) if isinstance(item, dict) else None
        if entry.get("entry") or entry.get("peak") or entry.get("buy_date"):
            out[symbol] = entry
    return out


def migrate_memory(memory, payload):
    """记录本次见到的 memory 版本；不认识的格式只做保守重建，绝不清空账户。"""
    seen_versions = []
    raw_seen = memory.get("seen_versions")
    if isinstance(raw_seen, list):
        for item in raw_seen:
            if isinstance(item, str) and item and item not in seen_versions:
                seen_versions.append(item[:64])
    current = payload.get("revision")
    if not isinstance(current, str) or not current:
        current = DEFAULT_REVISION
    if current not in seen_versions:
        seen_versions.append(current[:64])
    seen_versions = seen_versions[-8:]
    tags = []
    raw_tags = memory.get("seen_tags")
    if isinstance(raw_tags, list):
        for item in raw_tags:
            if isinstance(item, str) and item and item not in tags:
                tags.append(item[:48])
    if STRATEGY_TAG not in tags:
        tags.append(STRATEGY_TAG)
    return seen_versions, tags[-4:]


def load_cooldown(memory):
    raw = memory.get("cooldown")
    out = {}
    if isinstance(raw, dict):
        for symbol, date in raw.items():
            norm = norm_date(date)
            if isinstance(symbol, str) and norm:
                out[symbol] = norm
    return out


# ---------------------------------------------------------------------------
# 行情解析：每只股票一轮只保留最后一个有效快照 + 当日聚合
# ---------------------------------------------------------------------------

def build_bar(moment):
    """从单个快照的行情对象构造可用的 bar；无效返回 None。"""
    price = safe_float(moment.get("price"), None)
    if price is None:
        price = safe_float(moment.get("close"), None)
    if price is None or price <= 0:
        return None
    vol = safe_float(moment.get("vol"), 0.0)
    if vol is None or vol < 0:
        vol = 0.0
    return {
        "price": price,
        "open": safe_float(moment.get("open"), None),
        "high": safe_float(moment.get("high"), None),
        "low": safe_float(moment.get("low"), None),
        "pre_close": safe_float(moment.get("pre_close"), None),
        "reference_close": safe_float(moment.get("reference_close"), None),
        "vol": vol,
        "amount": safe_float(moment.get("amount"), None),
        "quote_time": moment.get("quote_time"),
        "quote_dt": parse_ts(moment.get("quote_time")),
        "up_limit": safe_float(moment.get("up_limit"), None),
        "down_limit": safe_float(moment.get("down_limit"), None),
    }


def parse_history(payload, universe, env, as_of):
    """返回 info：
       info[symbol] = 该股在 history 中**最后一个含有效报价**的当日快照聚合
                      （含最新价、当日开高低、reference_close/pre_close、累计量、
                       该股 quote_time 与相对 as_of 的年龄、fresh/stale 标记）。
       某股缺失、无效或过期时不会出现在 info 中，绝不用假价格补齐。"""
    rows = payload.get("history")
    if isinstance(rows, dict):  # 容忍以 slot 为键的对象形式
        rows = list(rows.values())
    if not isinstance(rows, list):
        rows = []

    info = {}
    latest_slot = None
    latest_as_of = None
    snapshot_count = 0

    for row in rows:
        if not isinstance(row, dict):
            continue
        snapshot_count += 1
        slot_dt = parse_ts(row.get("slot"))
        row_as_of_dt = parse_ts(row.get("as_of"))
        row_date = norm_date(row.get("date"))
        if row_date is None and row_as_of_dt is not None:
            row_date = row_as_of_dt.strftime("%Y-%m-%d")
        if row_date is None and as_of is not None:
            row_date = as_of.strftime("%Y-%m-%d")
        if slot_dt is not None and (latest_slot is None or slot_dt > latest_slot):
            latest_slot = slot_dt
        if row_as_of_dt is not None and (latest_as_of is None or row_as_of_dt > latest_as_of):
            latest_as_of = row_as_of_dt

        bars = row.get("bars")
        if not isinstance(bars, dict):
            continue
        for symbol, moment in bars.items():
            if symbol not in universe or not isinstance(moment, dict):
                continue
            bar = build_bar(moment)
            if bar is None:
                continue
            age = (as_of - row_as_of_dt).total_seconds() if (as_of and row_as_of_dt) else None
            bucket = info.get(symbol)
            if bucket is None:
                # 每只股票维护“最近一次含有效报价的当日桶”；日期后移时重置当日聚合
                bucket = {"date": row_date, "prices": [], "open": None, "high": None, "low": None,
                          "reference_close": None, "pre_close": None, "last_vol": None,
                          "slots": 0, "age": None, "quote_dt": None, "row_as_of": None}
                info[symbol] = bucket
            elif row_date and bucket["date"] and row_date > bucket["date"]:
                bucket.update({"date": row_date, "prices": [], "open": None, "high": None,
                               "low": None, "reference_close": None, "pre_close": None,
                               "last_vol": None, "slots": 0})
            bucket["date"] = row_date or bucket["date"]
            bucket["slots"] += 1
            bucket["prices"].append(bar["price"])
            bucket["age"] = age
            bucket["row_as_of"] = row_as_of_dt
            bucket["quote_dt"] = bar["quote_dt"]
            if bar["open"] is not None:
                bucket["open"] = bar["open"]
            if bar["high"] is not None:
                bucket["high"] = bar["high"] if bucket["high"] is None else max(bucket["high"], bar["high"])
            if bar["low"] is not None:
                bucket["low"] = bar["low"] if bucket["low"] is None else min(bucket["low"], bar["low"])
            if bar["reference_close"] is not None and bar["reference_close"] > 0:
                bucket["reference_close"] = bar["reference_close"]
            if bar["pre_close"] is not None and bar["pre_close"] > 0:
                bucket["pre_close"] = bar["pre_close"]
            bucket["last_vol"] = bar["vol"]

    for symbol, bucket in info.items():
        # 最新价 = 最后一行的报价（history 按时间升序；“中位价”在趋势日会明显偏离最新价，
        # 因此只作为区间参考，不用于估值与决策）
        bucket["median"] = median(bucket["prices"])
        bucket["last"] = bucket["prices"][-1] if bucket["prices"] else None
        bucket["fresh"] = bool(bucket["age"] is not None
                               and 0 <= bucket["age"] <= env["max_quote_age_seconds"])
        bucket["has_volume"] = bool(bucket["last_vol"] is not None and bucket["last_vol"] > 0)
        bucket["stale"] = not bucket["fresh"]

    return {
        "info": info,
        "snapshot_count": snapshot_count,
        "latest_slot": latest_slot,
        "latest_as_of": latest_as_of,
    }


# ---------------------------------------------------------------------------
# 自建跨日日序列（history 本身当天多、跨天少甚至只有 240 个点，故用 memory 累积）
# ---------------------------------------------------------------------------

def update_series(series, info, current_date, max_keep=SERIES_KEEP_DAYS):
    for symbol, entry in info.items():
        date = entry.get("date") or current_date
        if not date:
            continue
        # 只记录看起来有效的当日观测：价格为正；若当日累计成交量明确为 0 则视为无效快照
        if not entry.get("has_volume") and entry.get("last_vol") == 0:
            continue
        close = safe_float(entry.get("last"), None)
        if close is None or close <= 0:
            continue
        ref = safe_float(entry.get("reference_close"), None)
        if ref is not None and ref <= 0:
            ref = None
        bucket = series.setdefault(symbol, {})
        bucket[date] = (close, ref)
        if len(bucket) > max_keep:
            for old in sorted(bucket.keys())[:len(bucket) - max_keep]:
                bucket.pop(old, None)
    return series


def simplify_series(series, keep_days):
    """序列化前裁剪：按日期保留最近 keep_days 个观测，控制 memory 体积。"""
    out = {}
    for symbol, bucket in series.items():
        if not isinstance(bucket, dict) or not bucket:
            continue
        dates = sorted(bucket.keys())[-keep_days:]
        rows = []
        for date in dates:
            close, ref = bucket[date]
            rows.append([date, round(close, 3), (round(ref, 3) if ref is not None else None)])
        out[symbol] = rows
    return out


def _json_size(obj):
    try:
        return len(json.dumps(obj, ensure_ascii=False, allow_nan=False))
    except Exception:
        return 1 << 30


def clip_by_budget(memory):
    """确保 json.dumps(memory) 不超过协议限制；逐步降级而不是返回非法 memory。"""
    if _json_size(memory) <= MEMORY_BUDGET:
        return memory
    for keep_days in (60, 40, 25, 15, 8, 4, 2):
        trimmed = dict(memory)
        series = trimmed.get("series")
        if isinstance(series, dict):
            trimmed["series"] = {
                s: (rows[-keep_days:] if isinstance(rows, list) else rows)
                for s, rows in series.items()
            }
        trimmed["series_keep_days"] = keep_days
        if _json_size(trimmed) <= MEMORY_BUDGET:
            return trimmed
    minimal = {
        "schema": memory.get("schema", MEMORY_SCHEMA),
        "strategy_tag": memory.get("strategy_tag", STRATEGY_TAG),
        "strategy_version": memory.get("strategy_version", 1),
        "revision": memory.get("revision", DEFAULT_REVISION),
        "obs": memory.get("obs", 0),
        "last_slot": memory.get("last_slot"),
        "last_slot_key": memory.get("last_slot_key"),
        "last_date": memory.get("last_date"),
        "rotate_counter": memory.get("rotate_counter", 0),
        "equity": memory.get("equity"),
        "degraded": True,
    }
    return minimal


# ---------------------------------------------------------------------------
# 信号：动量 / 趋势 / 波动率 / 综合分
# ---------------------------------------------------------------------------

def daily_returns(bucket):
    """(日期升序, 日收益序列)。优先使用 reference_close 计算的当日收益（更接近日线口径），
       缺失时退化为相邻观测日收盘比。"""
    if not bucket:
        return [], []
    dates = sorted(bucket.keys())
    returns = []
    for idx in range(1, len(dates)):
        cur_close, cur_ref = bucket[dates[idx]]
        prev_close, _prev_ref = bucket[dates[idx - 1]]
        base = cur_ref if (cur_ref is not None and cur_ref > 0) else prev_close
        if base and base > 0:
            returns.append(cur_close / base - 1.0)
    return dates, returns


def realized_volatility(bucket, fallback_range):
    _dates, returns = daily_returns(bucket)
    if len(returns) >= 5:
        window = returns[-VOL_WINDOW:]
        return clamp(stdev(window), VOL_FLOOR, VOL_CAP), True
    if fallback_range is not None and fallback_range > 0:
        return clamp(fallback_range * 0.6, VOL_FLOOR, VOL_CAP), False
    return clamp(0.025, VOL_FLOOR, VOL_CAP), False


def compute_metrics(symbol, entry, bucket, current_date):
    """为单只股票计算评分所需指标；数据不足的字段返回 None。"""
    last = safe_float(entry.get("last"), None)
    if last is None or last <= 0:
        return None
    ref = safe_float(entry.get("reference_close"), None)
    if ref is None or ref <= 0:
        ref = safe_float(entry.get("pre_close"), None)
    if ref is not None and ref <= 0:
        ref = None

    closes = []
    if bucket:
        seq = [(d, v) for d, v in bucket.items() if d <= current_date] if current_date else list(bucket.items())
        seq.sort()
        closes = [v[0] for _d, v in seq]

    def ret_over(days):
        if len(closes) >= days + 1 and closes[-days - 1] > 0:
            return closes[-1] / closes[-days - 1] - 1.0
        return None

    r1 = ret_over(1)
    r5 = ret_over(5)
    r20 = ret_over(20)
    if r5 is not None and r20 is not None:
        mid = 0.6 * r5 + 0.4 * r20
    elif r5 is not None:
        mid = r5
    elif r20 is not None:
        mid = 0.5 * r20
    elif r1 is not None:
        mid = 0.5 * r1
    else:
        mid = None

    day_ret = (last / ref - 1.0) if ref else None
    if day_ret is not None and abs(day_ret) > MAX_DAILY_MOVE:
        day_ret = None

    open_px = safe_float(entry.get("open"), None)
    intraday = (last / open_px - 1.0) if (open_px and open_px > 0) else None
    if intraday is not None and abs(intraday) > MAX_INTRADAY_MOVE:
        intraday = None

    # 同一交易日内首个槽位的漂移：作为开盘后不久的补充动量（开盘价此时几乎无信息）
    prices = [p for p in (entry.get("prices") or []) if p and p > 0]
    slot_drift = None
    if len(prices) >= MIN_QUOTE_MATCH and prices[0] > 0:
        slot_drift = prices[-1] / prices[0] - 1.0
        if abs(slot_drift) > MAX_INTRADAY_MOVE:
            slot_drift = None

    high = safe_float(entry.get("high"), None)
    low = safe_float(entry.get("low"), None)
    day_range = None
    if high and low and high > 0 and low > 0 and high >= low and ref:
        day_range = (high - low) / ref

    vol, vol_from_daily = realized_volatility(bucket, day_range)

    # 综合分：中期动量为主，日内动量为辅；跨日数据严重不足时退化为纯日内/槽内信号
    if len(closes) >= 3 and mid is not None and intraday is not None:
        score = 0.65 * mid + 0.45 * intraday
        mode = "mid+intraday"
    elif len(closes) >= 3 and mid is not None:
        score = mid
        mode = "mid"
    elif intraday is not None and abs(intraday) >= INTRADAY_MIN_MOVE:
        score = 0.60 * intraday
        mode = "intraday"
    elif slot_drift is not None and abs(slot_drift) >= INTRADAY_MIN_MOVE:
        score = 0.45 * slot_drift
        mode = "slotdrift"
    else:
        return None  # 既无跨日历史也无有效日内动量：不猜测，空仓等待

    short_avg = None
    long_avg = None
    if len(closes) >= 3:
        short_avg = mean(closes[-3:])
    if len(closes) >= 10:
        long_avg = mean(closes[-10:])
    elif r20 is not None:
        short_avg, long_avg = closes[-1], None
    trend_ok = True
    if short_avg is not None and long_avg is not None and long_avg > 0:
        trend_ok = short_avg >= long_avg * 0.995

    up_limit = safe_float(entry.get("up_limit"), None)
    down_limit = safe_float(entry.get("down_limit"), None)
    near_up = bool(up_limit and last >= up_limit * (1 - LIMIT_GUARD))
    near_down = bool(down_limit and last <= down_limit * (1 + LIMIT_GUARD))

    return {
        "symbol": symbol,
        "last": last,
        "ref": ref,
        "r1": r1, "r5": r5, "r20": r20,
        "mid": mid,
        "day_ret": day_ret,
        "intraday": intraday,
        "slot_drift": slot_drift,
        "mode": mode,
        "vol": vol,
        "vol_from_daily": vol_from_daily,
        "score": score,
        "trend_ok": trend_ok,
        "near_up": near_up,
        "near_down": near_down,
        "fresh": bool(entry.get("fresh")),
        "has_volume": bool(entry.get("has_volume")),
        "stale": bool(entry.get("stale")),
        "days_available": len(closes),
    }


# ---------------------------------------------------------------------------
# 交易成本与股数计算
# ---------------------------------------------------------------------------

def gross_of(price, quantity):
    return round(price * quantity, 2)


def fees_of(gross, side, env):
    commission = max(env["minimum_commission"], gross * env["commission_rate"])
    tax = gross * env["sell_tax_rate"] if side == "sell" else 0.0
    return round(commission + tax, 2)


def buy_cash_needed(price, quantity, env):
    """买单占用的现金上界：成交价按当前价上浮 slippage，再加佣金。"""
    fill = price * (1.0 + env["slippage_bps"] / 10000.0)
    gross = gross_of(fill, quantity)
    return round(gross + fees_of(gross, "buy", env), 2)


def sell_cash_gain(price, quantity, env):
    """卖单回款下界：成交价按当前价下浮 slippage，再扣佣金与印花税。"""
    fill = price * (1.0 - env["slippage_bps"] / 10000.0)
    gross = gross_of(fill, quantity)
    return round(gross - fees_of(gross, "sell", env), 2)


def lots_for_weight(weight, equity, price, env, lot):
    """把目标权重换算成整手股数；price 无效或权重<=0 返回 0。"""
    if weight <= 0 or price is None or price <= 0 or equity <= 0:
        return 0
    notional = weight * equity
    fill = price * (1.0 + env["slippage_bps"] / 10000.0)
    raw_lots = int(notional // (fill * lot))
    return max(0, raw_lots) * lot


def affordable_lots(price, cash, env, lot):
    """在给定现金下最多能买多少整手（含费用与最低佣金）。"""
    if price is None or price <= 0 or cash <= 0:
        return 0
    unit = buy_cash_needed(price, lot, env)
    if unit <= 0:
        return 0
    lots = int(cash // unit)
    while lots > 0 and buy_cash_needed(price, lots * lot, env) > cash:
        lots -= 1
    return max(0, lots) * lot


# ---------------------------------------------------------------------------
# 主决策流程
# ---------------------------------------------------------------------------

def build_output(orders, memory, commentary):
    return {"orders": orders, "memory": memory, "commentary": commentary}


def decide(payload):
    as_of_raw = payload.get("as_of")
    slot_raw = payload.get("slot")
    as_of = parse_ts(as_of_raw) or parse_ts(slot_raw)
    slot_dt = parse_ts(slot_raw) or as_of
    if as_of is None:
        raise ValueError("missing as_of/slot")

    env = load_environment(payload.get("environment"))
    lot = env["lot_size"]
    universe = env["universe"]
    universe_set = set(universe)
    current_date = as_of.strftime("%Y-%m-%d")

    # ---- memory 迁移与装载 -------------------------------------------------
    memory = load_memory(payload.get("memory"), payload.get("memory"))
    account = payload.get("account") if isinstance(payload.get("account"), dict) else {}
    if not memory:
        memory = load_memory(account.get("memory"), account.get("memory"))
    if not memory:
        memory = {}
    seen_versions, seen_tags = migrate_memory(memory, payload)
    series = load_price_series(memory)
    pos_state = load_pos_state(memory)
    cooldown = load_cooldown(memory)
    schema_known = memory.get("schema") in (None, MEMORY_SCHEMA)

    # ---- 账户 -------------------------------------------------------------
    cash = safe_float(account.get("cash"), 0.0)
    equity = safe_float(account.get("equity"), 0.0)
    peak = safe_float(account.get("peak"), equity)
    max_dd = safe_float(account.get("max_drawdown"), 0.0)
    if equity <= 0:
        equity = max(0.0, cash)
    positions_raw = account.get("positions") if isinstance(account.get("positions"), dict) else {}

    positions = {}
    for symbol, item in positions_raw.items():
        if not isinstance(symbol, str) or not isinstance(item, dict):
            continue
        quantity = safe_int(item.get("quantity"), 0) or 0
        if quantity <= 0:
            continue
        sellable = safe_int(item.get("sellable"), 0) or 0
        cost = safe_float(item.get("cost"), None)
        last_price = safe_float(item.get("last_price"), None)
        state = pos_state.get(symbol, {})
        buy_date = state.get("buy_date")
        # T+1 硬约束：记忆中当日买入的份额本轮绝不卖出；否则以账户 sellable 为准
        if buy_date is not None and buy_date == current_date:
            allowed = 0
        else:
            allowed = min(quantity, max(0, sellable))
        if symbol not in universe_set:
            allowed = 0  # 不在股票池内的历史持仓只持有，不下新单（协议不允许交易）
        positions[symbol] = {
            "quantity": quantity,
            "sellable": max(0, allowed),
            "raw_sellable": max(0, min(quantity, max(0, sellable))),
            "cost": cost,
            "last_price": last_price,
            "buy_date": buy_date,
            "entry": state.get("entry"),
            "peak": state.get("peak"),
        }

    pending = account.get("pending") if isinstance(account.get("pending"), list) else []
    pending_buy_cash = 0.0
    pending_sell_qty = {}
    for order in pending:
        if not isinstance(order, dict):
            continue
        symbol = order.get("symbol")
        side = order.get("side")
        qty = safe_int(order.get("quantity"), 0) or 0
        if qty <= 0 or symbol not in universe_set:
            continue
        ref_price = None
        if symbol in positions and positions[symbol]["last_price"]:
            ref_price = positions[symbol]["last_price"]
        if side == "buy" and ref_price:
            pending_buy_cash += buy_cash_needed(ref_price, qty, env)
        elif side == "sell":
            pending_sell_qty[symbol] = pending_sell_qty.get(symbol, 0) + qty

    # ---- 行情 -------------------------------------------------------------
    hist = parse_history(payload, universe_set, env, as_of)
    info = hist["info"]
    snapshots = hist["snapshot_count"]

    # 幂等保护：若本轮所有报价与该股上次决策时完全一样（调度迟到/重放），
    # 重复下单没有意义且会被拒单，因此只更新状态、不再下单。
    quote_marks = {}
    for symbol, entry in info.items():
        quote_dt = entry.get("quote_dt")
        quote_marks[symbol] = quote_dt.isoformat() if quote_dt is not None else None
    prev_marks = memory.get("quote_marks") if isinstance(memory.get("quote_marks"), dict) else {}
    duplicate = bool(quote_marks) and quote_marks == prev_marks

    series = update_series(series, info, current_date)

    # ---- 指标 -------------------------------------------------------------
    metrics = {}
    for symbol, entry in info.items():
        bucket = series.get(symbol, {})
        metric = compute_metrics(symbol, entry, bucket, current_date)
        if metric is not None:
            metrics[symbol] = metric

    # ---- 风险预算 ---------------------------------------------------------
    drawdown = safe_float(max_dd, 0.0) or 0.0
    if drawdown < 0:
        drawdown = -drawdown
    gross_cap = DEFAULT_GROSS
    for threshold, scale in DRAWDOWN_TIERS:
        if drawdown >= threshold:
            gross_cap = min(gross_cap, scale)

    # 更新持仓峰值（用于移动止损）
    new_pos_state = {}
    for symbol, pos in positions.items():
        state = dict(pos_state.get(symbol, {}))
        last = info.get(symbol, {}).get("last") if symbol in info else None
        if last is None:
            last = pos.get("last_price")
        entry_price = safe_float(state.get("entry"), None)
        if entry_price is None:
            entry_price = safe_float(pos.get("cost"), None)
        if entry_price is None:
            entry_price = last
        peak = safe_float(state.get("peak"), None)
        if peak is None:
            peak = last
        if last is not None and (peak is None or last > peak):
            peak = last
        state["entry"] = round_or_none(entry_price)
        state["peak"] = round_or_none(peak)
        # 只有在“首次见到该持仓”时才把今天当作买入日，避免把老仓误标成当日买入而无法卖出
        state["buy_date"] = pos.get("buy_date") or state.get("buy_date") or current_date
        state["entry_date"] = state.get("entry_date") or current_date
        state["seen"] = current_date
        if state.get("tw") is not None:
            state["tw"] = round_or_none(state.get("tw"), 4)
        if state.get("exit_date"):
            state["exit_date"] = norm_date(state.get("exit_date"))
        new_pos_state[symbol] = state
    # 保留近期离场记录（用于冷却判断），限制数量
    for symbol, state in pos_state.items():
        if symbol in new_pos_state or symbol not in universe_set:
            continue
        entry_date = state.get("entry_date")
        if entry_date and entry_date >= current_date:
            continue
        if len(new_pos_state) > 24:
            break
        new_pos_state[symbol] = {
            "entry": round_or_none(state.get("entry")),
            "peak": round_or_none(state.get("peak")),
            "buy_date": state.get("buy_date"),
            "entry_date": entry_date,
            "seen": current_date,
        }

    determine_metrics_loop = None
    # ---- 建仓/再平衡的轮换闸门 -------------------------------------------
    slot_key = _slot_key(slot_dt)
    counter = safe_int(memory.get("rotate_counter"), 0) or 0
    if memory.get("last_date") != current_date:
        counter = 0  # 新交易日重置计数，保证当日第一个槽位即可建仓
    new_slot = bool(memory.get("last_slot_key") != slot_key)
    if new_slot:
        counter += 1
    can_rotate = new_slot and (counter % ROTATE_EVERY == 1)

    # ---- 卖出决定 ---------------------------------------------------------
    orders = []
    planned_sell_qty = {}
    planned_sell_cash = 0.0
    exit_reasons = {}
    remaining_sellable = {s: p["sellable"] for s, p in positions.items()}

    # 幂等：报价未更新时不再下单（避免重复挂单与无意义的拒单）
    if duplicate:
        for symbol, pos in positions.items():
            exit_reasons[symbol] = "报价未更新，本轮沿用既有挂单/持仓，不重复下单"

    for symbol, pos in positions.items():
        if duplicate:
            break
        metric = metrics.get(symbol)
        last = metric["last"] if metric else pos.get("last_price")
        if last is None or last <= 0:
            continue
        cost = pos.get("cost")
        peak = pos.get("peak") or pos.get("entry")
        score = metric["score"] if metric is not None else None
        mid = metric["mid"] if metric is not None else None
        reason = None
        partial = False
        if metric is not None and metric["near_down"]:
            reason = "逼近跌停，规避流动性风险"
        if reason is None and cost and cost > 0 and last <= cost * (1 + STOP_LOSS):
            reason = "触发止损：现价 %.2f 低于成本 %.2f 的 %.0f%%" % (last, cost, abs(STOP_LOSS) * 100)
        if reason is None and peak and peak > 0 and last <= peak * (1 + TRAIL_STOP):
            reason = "触发移动止损：自持仓高点 %.2f 回撤超 %.0f%%" % (peak, abs(TRAIL_STOP) * 100)
        if reason is None and score is not None and score < EXIT_SCORE:
            reason = "动量反转：综合分 %.3f 低于退出阈值" % score
        if reason is None and mid is not None and mid < -0.05:
            reason = "中期动量为负：中动量 %.3f" % mid
        if reason is None and metric is not None and metric["day_ret"] is not None:
            day_ret = metric["day_ret"]
            if day_ret <= CRASH_EXIT_MOVE:
                reason = "急速下跌减半：当日 %+.2f%% 弱于 %.1f%% 阈值" % (
                    day_ret * 100.0, CRASH_EXIT_MOVE * 100.0)
                partial = True
            elif day_ret <= -0.045:
                reason = "急速下跌清仓：当日 %+.2f%%" % (day_ret * 100.0)
        if (reason is None and can_rotate and cost and cost > 0
                and last >= cost * (1 + TAKE_PROFIT)):
            reason = "止盈减半：现价 %.2f 高于成本 %.2f 的 %.0f%%" % (last, cost, TAKE_PROFIT * 100)
            partial = True
        if reason is None:
            continue
        allowed = remaining_sellable.get(symbol, 0)
        qty = (allowed // lot) * lot
        if partial:
            qty = ((qty // 2) // lot) * lot
        if qty <= 0:
            exit_reasons[symbol] = reason + "（当日买入/不可卖，T+1 限制，暂缓）"
            continue
        orders.append({"symbol": symbol, "side": "sell", "quantity": qty, "reason": reason[:1000]})
        remaining_sellable[symbol] = allowed - qty
        planned_sell_qty[symbol] = planned_sell_qty.get(symbol, 0) + qty
        planned_sell_cash += sell_cash_gain(last, qty, env)
        exit_reasons[symbol] = reason
        if not partial:
            cooldown[symbol] = current_date
            new_pos_state.pop(symbol, None)

    available_cash = cash + planned_sell_cash - pending_buy_cash

    # ---- 候选与目标权重 ---------------------------------------------------
    eligible = []
    if not duplicate:
        for symbol in universe:
            metric = metrics.get(symbol)
            if metric is None or not metric["fresh"] or not metric["has_volume"]:
                continue
            if metric["near_up"] or metric["near_down"]:
                continue
            if metric["day_ret"] is not None and metric["day_ret"] > 0.08:
                continue
            if metric["score"] is None or metric["score"] <= MIN_BUY_SCORE:
                continue
            # 跨日历史不足时，只接受日内/槽内动量足够明确的标的（否则不猜测）
            if metric["mode"] in ("intraday", "slotdrift"):
                move = metric["intraday"] if metric["mode"] == "intraday" else metric["slot_drift"]
                if move is None or abs(move) < INTRADAY_MIN_MOVE:
                    continue
            if not metric["trend_ok"]:
                continue
            if symbol in positions and cooldown.get(symbol) and current_date >= cooldown[symbol]:
                cooled = _day_gap(cooldown[symbol], current_date)
                if cooled is not None and cooled < EXIT_COOLDOWN_DAYS:
                    continue
            eligible.append(metric)
    eligible.sort(key=lambda m: (-m["score"], m["symbol"]))

    # 只有存在当日有效报价的持仓才参与权重分配；缺报价的持仓不因缺数据被强制卖出
    held_symbols = [s for s in positions if s not in planned_sell_qty and s in metrics]

    def target_weight(metric):
        """单票目标权重：波动率目标 * 分数倾斜 * 回撤降险，并受单票上限约束。"""
        vol = clamp(metric["vol"], VOL_FLOOR, VOL_CAP)
        score = metric["score"] if metric["score"] is not None else 0.0
        tilt = clamp(1.0 + 4.0 * score, SCORE_TILT_MIN, SCORE_TILT_MAX)
        weight = (TARGET_VOL / vol) * tilt * gross_cap / max(len(held_symbols) + 1, 1)
        return min(weight, WEIGHT_CAP)

    # 持仓的目标权重在“开仓/轮换”时确定并写入 memory，之后用固定目标判断是否超配，
    # 避免因组合成员变化导致目标漂移、从而产生无意义的连续减仓（换手与手续费）。
    targets = {}
    target_state = {}
    for symbol in sorted(held_symbols, key=lambda s: -((metrics.get(s) or {}).get("last") or 0.0)
                         * (positions[s]["quantity"] if s in positions else 0)):
        metric = metrics.get(symbol)
        pos = positions.get(symbol)
        if metric is None or pos is None:
            continue
        stored = safe_float(new_pos_state.get(symbol, {}).get("tw"), None)
        if stored is None or stored <= 0 or stored > WEIGHT_CAP:
            stored = target_weight(metric)
        targets[symbol] = min(stored * gross_cap, WEIGHT_CAP)
        target_state[symbol] = min(stored, WEIGHT_CAP)

    if can_rotate:
        free_slots = MAX_POSITIONS - len(targets)
        for metric in eligible:
            if free_slots <= 0:
                break
            symbol = metric["symbol"]
            if symbol in targets:
                continue
            weight = target_weight(metric)
            targets[symbol] = weight
            target_state[symbol] = min(weight, WEIGHT_CAP)
            free_slots -= 1

    if can_rotate:
        equity_ref = max(equity, 1.0)
        # 敞口预算：已有持仓 + 计划买入不得高于 gross_cap，避免意外借款
        projected_gross = 0.0
        for symbol, pos in positions.items():
            ref_price = metrics[symbol]["last"] if symbol in metrics else pos.get("last_price")
            projected_gross += max(0.0, (pos["quantity"] - planned_sell_qty.get(symbol, 0))
                                   * (ref_price or 0.0))
        gross_budget = gross_cap * equity_ref
        min_notional = max(MIN_TRADE_DRIFT * equity_ref, 1.0)

        # 1) 只做“确实过大”的减仓，避免小额度来回调整
        for symbol in sorted(held_symbols, key=lambda s: -targets.get(s, 0.0)):
            metric = metrics.get(symbol)
            pos = positions.get(symbol)
            if metric is None or pos is None:
                continue
            price = metric["last"]
            if price is None or price <= 0:
                continue
            target_qty = lots_for_weight(targets.get(symbol, 0.0), equity, price, env, lot)
            allowed = remaining_sellable.get(symbol, 0)
            excess = ((pos["quantity"] - target_qty) // lot) * lot
            if excess <= 0 or excess * price < min_notional:
                continue
            qty = (min(allowed, excess) // lot) * lot
            if qty <= 0:
                continue
            orders.append({
                "symbol": symbol, "side": "sell", "quantity": qty,
                "reason": "超配减仓：现权重 %.1f%% 高于目标 %.1f%%" % (
                    pos["quantity"] * price / equity_ref * 100.0, targets.get(symbol, 0.0) * 100.0),
            })
            remaining_sellable[symbol] = allowed - qty
            planned_sell_qty[symbol] = planned_sell_qty.get(symbol, 0) + qty
            planned_sell_cash += sell_cash_gain(price, qty, env)
            projected_gross -= qty * price
            if len(orders) >= MAX_ORDERS:
                break

        # 2) 有空仓位时按综合分从高到低建仓；不因微小偏离加仓旧仓
        held_now = set(held_symbols) | set(planned_sell_qty)
        for metric in eligible:
            if len(orders) >= MAX_ORDERS:
                break
            symbol = metric["symbol"]
            if symbol in held_now:
                continue
            if len(held_now) >= MAX_POSITIONS:
                break
            if metric["near_up"] or not metric["fresh"] or not metric["has_volume"]:
                continue
            price = metric["last"]
            if price is None or price <= 0:
                continue
            weight = min(targets.get(symbol, 0.0), WEIGHT_CAP)
            want = lots_for_weight(weight, equity, price, env, lot)
            if want <= 0:
                continue
            room = gross_budget - projected_gross
            qty = _cap_by_cash(want, price, available_cash, env, lot)
            qty = _cap_by_gross(qty, price, room, lot)
            if qty <= 0 or qty * price < min_notional:
                continue
            orders.append({
                "symbol": symbol, "side": "buy", "quantity": qty,
                "reason": "建仓：综合分 %.3f（%.3f 日 / 日内 %+.2f%%），波动率 %.1f%%，目标权重 %.1f%%" % (
                    metric["score"], metric["mid"] if metric["mid"] is not None else 0.0,
                    (metric["intraday"] or 0.0) * 100.0, metric["vol"] * 100.0, weight * 100.0),
            })
            available_cash -= buy_cash_needed(price, qty, env)
            projected_gross += qty * price
            held_now.add(symbol)
            bought = new_pos_state.setdefault(symbol, {})
            bought["buy_date"] = current_date
            bought["entry"] = round_or_none(price)
            bought["peak"] = round_or_none(price)
            bought["entry_date"] = current_date
            bought["seen"] = current_date
            bought["tw"] = round_or_none(target_state.get(symbol, weight), 4)

    # ---- 输出整理 ---------------------------------------------------------
    orders = _sanitize_orders(orders, positions, universe_set, lot, env)
    if len(orders) > MAX_ORDERS:
        orders = orders[:MAX_ORDERS]

    series_out = simplify_series(series, SERIES_KEEP_DAYS)
    memory_out = {
        "schema": MEMORY_SCHEMA,
        "strategy_tag": STRATEGY_TAG,
        "strategy_version": 1,
        "revision": payload.get("revision") if isinstance(payload.get("revision"), str) else DEFAULT_REVISION,
        "seen_versions": seen_versions,
        "seen_tags": seen_tags,
        "migrated": bool(not schema_known or (memory.get("strategy_tag") not in (None, STRATEGY_TAG))),
        "obs": (safe_int(memory.get("obs"), 0) or 0) + 1,
        "last_slot": slot_raw if isinstance(slot_raw, str) else None,
        "last_slot_key": slot_key,
        "last_as_of": as_of_raw if isinstance(as_of_raw, str) else None,
        "last_date": current_date,
        "rotate_counter": counter,
        "equity": round_or_none(equity, 2),
        "peak": round_or_none(peak, 2),
        "max_drawdown": round_or_none(drawdown, 4),
        "cash": round_or_none(cash, 2),
        "gross_cap": round_or_none(gross_cap, 3),
        "series_keep_days": SERIES_KEEP_DAYS,
        "quote_marks": quote_marks,
        "series": series_out,
        "pos": new_pos_state,
        "cooldown": {s: d for s, d in list(cooldown.items())[-24:] if isinstance(d, str)},
        "pending_round": {
            "submitted_at": as_of_raw if isinstance(as_of_raw, str) else None,
            "n": len(orders),
            "sells": sum(1 for o in orders if o["side"] == "sell"),
            "buys": sum(1 for o in orders if o["side"] == "buy"),
        },
    }
    memory_out = _prune_memory(memory_out, universe_set)
    memory_out = clip_by_budget(memory_out)

    commentary = _commentary(
        current_date, slot_raw, env, positions, metrics, eligible, targets,
        orders, exit_reasons, drawdown, gross_cap, can_rotate, snapshots, series, hist,
    )
    return build_output(orders, memory_out, commentary[:4000])


MAX_ORDER_QTY = 1000000000  # 协议上限，仅为防御性裁剪


def _day_gap(date_a, date_b):
    """两个 YYYY-MM-DD 的自然日差；无法解析返回 None。"""
    try:
        a = _dt.date.fromisoformat(date_a)
        b = _dt.date.fromisoformat(date_b)
    except Exception:
        return None
    return (b - a).days


def _slot_key(slot_dt):
    """把槽位对齐到 10 分钟刻度，得到可比较的字符串键；无槽位时用空串。"""
    if slot_dt is None:
        return ""
    minute = (slot_dt.minute // 10) * 10
    return "%04d-%02d-%02dT%02d:%02d" % (slot_dt.year, slot_dt.month, slot_dt.day, slot_dt.hour, minute)


def _cap_by_gross(want, price, room, lot):
    """把买入股数限制在总敞口预算之内。"""
    if want <= 0 or price is None or price <= 0 or room <= 0:
        return 0
    qty = min(want, int(room // price))
    qty = (qty // lot) * lot
    return max(0, qty)


def _cap_by_cash(want, price, cash, env, lot):
    """在现金（含借款上限）与协议股数上限内裁剪买入股数。"""
    if want <= 0 or price is None or price <= 0 or cash <= 0:
        return 0
    qty = min(want, MAX_ORDER_QTY)
    limit = affordable_lots(price, cash, env, lot)
    qty = min(qty, limit)
    qty = (qty // lot) * lot
    return max(0, qty)


def _sanitize_orders(orders, positions, universe_set, lot, env):
    """最终校验：positive int、整手、池内、卖出不超过可卖、买后现金不低于 -max_debt。"""
    out = []
    remaining_sellable = {}
    for symbol, pos in positions.items():
        remaining_sellable[symbol] = pos.get("sellable", 0)
    cash_after = None
    for order in orders:
        if not isinstance(order, dict):
            continue
        symbol = order.get("symbol")
        side = order.get("side")
        qty = order.get("quantity")
        reason = order.get("reason")
        if not isinstance(symbol, str) or symbol not in universe_set:
            continue
        if side not in ("buy", "sell"):
            continue
        if isinstance(qty, bool) or not isinstance(qty, int):
            continue
        if qty <= 0:
            continue
        qty = min(qty, MAX_ORDER_QTY)
        qty = (qty // lot) * lot
        if qty <= 0:
            continue
        if side == "sell":
            allowed = remaining_sellable.get(symbol, 0)
            qty = min(qty, (allowed // lot) * lot)
            if qty <= 0:
                continue
            remaining_sellable[symbol] = allowed - qty
        if not isinstance(reason, str):
            reason = "策略信号"
        out.append({"symbol": symbol, "side": side, "quantity": int(qty), "reason": reason[:1000]})
        if len(out) >= MAX_ORDERS:
            break
    return out


def _prune_memory(memory, universe_set):
    """裁剪 memory：只保留池内股票、限制条目数量，防止无界增长。"""
    series = memory.get("series")
    if isinstance(series, dict):
        memory["series"] = {s: rows for s, rows in series.items() if s in universe_set}
    pos = memory.get("pos")
    if isinstance(pos, dict):
        memory["pos"] = {s: state for s, state in list(pos.items())[-32:] if s in universe_set}
    cooldown = memory.get("cooldown")
    if isinstance(cooldown, dict):
        memory["cooldown"] = {s: d for s, d in list(cooldown.items())[-24:] if s in universe_set}
    return memory


def _commentary(current_date, slot_raw, env, positions, metrics, eligible, targets,
                orders, exit_reasons, drawdown, gross_cap, can_rotate, snapshots,
                series, hist):
    buys = [o for o in orders if o["side"] == "buy"]
    sells = [o for o in orders if o["side"] == "sell"]
    fresh = sum(1 for m in metrics.values() if m["fresh"])
    stale = [m["symbol"] for m in metrics.values() if not m["fresh"]]
    top = eligible[:3]
    parts = []
    parts.append("[%s %s] 快照%d条，有效报价%d/%d，持仓%d只" % (
        current_date, slot_raw if isinstance(slot_raw, str) else "-",
        snapshots, fresh, len(env["universe"]), len(positions)))
    if top:
        parts.append("候选前三：" + "、".join(
            "%s(分%.3f,日%+.2f%%,波%.1f%%)" % (
                m["symbol"], m["score"],
                (m["day_ret"] or 0.0) * 100.0, m["vol"] * 100.0) for m in top))
    else:
        parts.append("无合格候选（要求有效报价、非涨跌停附近、综合分为正且趋势未破坏）")
    parts.append("本轮%s，买入%d笔、卖出%d笔" % ("再平衡槽位" if can_rotate else "观察槽位（仅退出信号）", len(buys), len(sells)))
    if exit_reasons:
        parts.append("退出触发：" + "；".join("%s:%s" % (s, r) for s, r in list(exit_reasons.items())[:3]))
    parts.append("回撤%.1f%%，敞口上限系数%.2f，日序列股票数%d" % (
        drawdown * 100.0, gross_cap, len([s for s, b in series.items() if b])))
    return " | ".join(parts)


# ---------------------------------------------------------------------------
# 入口：任何异常都必须以合法 JSON 退出，避免整轮信号失败
# ---------------------------------------------------------------------------

def _fallback_memory(payload):
    base = {}
    mem = payload.get("memory") if isinstance(payload, dict) else None
    if not isinstance(mem, dict):
        account = payload.get("account") if isinstance(payload, dict) else None
        mem = account.get("memory") if isinstance(account, dict) else None
    if isinstance(mem, dict):
        # 保留可安全序列化的旧字段，避免升级/异常时丢失辅助状态
        for key in ("series", "pos", "cooldown", "obs", "last_slot_key", "rotate_counter",
                    "strategy_tag", "strategy_version", "schema", "revision",
                    "seen_versions", "seen_tags", "last_date"):
            if key in mem:
                try:
                    json.dumps(mem[key], ensure_ascii=False, allow_nan=False)
                    base[key] = mem[key]
                except Exception:
                    continue
    base.setdefault("schema", MEMORY_SCHEMA)
    base.setdefault("strategy_tag", STRATEGY_TAG)
    base.setdefault("strategy_version", 1)
    base["error_fallback"] = True
    return clip_by_budget(base)


def main():
    raw = sys.stdin.read()
    payload = None
    try:
        payload = json.loads(raw) if raw and raw.strip() else {}
        if not isinstance(payload, dict):
            payload = {}
    except Exception as exc:  # 无法解析输入时也要给出合法 JSON
        sys.stderr.write("input json error: %r\n" % (exc,))
        payload = {}

    try:
        digest = hashlib.sha256(raw.encode("utf-8", "ignore")).hexdigest()[:16]
    except Exception:
        digest = "n/a"

    try:
        result = decide(payload)
        result["commentary"] = (str(result.get("commentary") or "") + " | in_hash=%s" % digest)[:4000]
    except Exception as exc:
        sys.stderr.write("decide error: %r\n" % (exc,))
        result = build_output([], _fallback_memory(payload), "本轮发生内部异常，保守空仓等待；详见 stderr")

    try:
        json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)
        sys.stdout.write("\n")
        sys.stdout.flush()
    except Exception as exc:
        sys.stderr.write("dump error: %r\n" % (exc,))
        sys.stdout.write(json.dumps({
            "orders": [],
            "memory": {"schema": MEMORY_SCHEMA, "strategy_tag": STRATEGY_TAG, "error_fallback": True},
            "commentary": "输出兜底",
        }, ensure_ascii=False))
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # 极端兜底
        sys.stderr.write("fatal: %r\n" % (exc,))
        try:
            sys.stdout.write('{"orders": [], "memory": {}, "commentary": "fatal fallback"}')
            sys.stdout.write("\n")
        except Exception:
            pass
        sys.exit(0)