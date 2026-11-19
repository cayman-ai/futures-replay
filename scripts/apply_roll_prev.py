#!/usr/bin/env python3
"""換月日補上「同一契約前一交易日」的日盤高低（prevHigh／prevLow），並重算統計。
來源：reports/official_all.json（期交所期貨每日交易行情，TX 一般交易時段，全部月份）。"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import update as U

off = json.loads((U.ROOT / "reports" / "official_all.json").read_text("utf-8"))
dates = sorted(off)
stats = U.load("statistics.json")
daily = stats["daily"]
n = 0
for prev, d in zip(daily, daily[1:]):
    if d["contract"] == prev["contract"]:
        d.pop("prevHigh", None); d.pop("prevLow", None)
        continue
    pd = dates[dates.index(d["date"]) - 1]
    if pd != prev["date"]:
        sys.exit(f"{d['date']} 前一交易日不一致：{pd} / {prev['date']}")
    o = off[pd].get(d["contract"])
    d["prevHigh"], d["prevLow"] = (o["high"], o["low"]) if o else (None, None)
    n += 1
U.dump("statistics.json", U.rebuild_stats(stats))
print("換月日", n, "天；沒有前一日同契約資料：", sum(1 for d in daily if "prevHigh" in d and d["prevHigh"] is None))
