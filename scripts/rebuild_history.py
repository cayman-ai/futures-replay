#!/usr/bin/env python3
"""把 statistics.json 的歷史日線換成期交所官方「日盤近月」資料，並重算全部統計。

輸入：reports/official_daily.json（由 scripts/verify.py 從期交所期貨每日交易行情產生；
      每日 TX 一般交易時段近月契約，結算日改用次月）。
- 舊的 rule(COW).xls 日線（實為夜盤＋日盤合併）全部換掉。
- 11/16 起用逐筆算的日線保留，但必須與官方一致，否則中止。
- 累積日高日低：每天改用與日線相同的契約（結算日用次月），從逐筆重算。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update as U  # noqa: E402

SRC = "https://www.taifex.com.tw/cht/3/futDataDown"


def main():
    official = {r["date"]: r for r in json.loads((U.ROOT / "reports" / "official_daily.json").read_text("utf-8"))}
    stats = U.load("statistics.json")
    latest = stats["latest"]
    new_daily = []
    for d in stats["daily"]:
        o = official.get(d["date"])
        if o is None:
            sys.exit(f"{d['date']} 官方沒有資料，中止")
        if d.get("contract"):  # 逐筆算的日線
            if d["contract"] != o["contract"] or [d[k] for k in ("open", "high", "low", "close")] != [o[k] for k in ("open", "high", "low", "close")]:
                sys.exit(f"{d['date']} 逐筆日線與官方不同：{d} / {o}，中止")
            new_daily.append(d)
            continue
        new_daily.append({
            "date": d["date"], "contract": o["contract"], "open": o["open"], "high": o["high"],
            "low": o["low"], "close": o["close"], "amplitude": o["high"] - o["low"],
            "file": "期交所期貨每日交易行情（TX 一般交易時段）", "sourcePath": SRC,
        })
    extra = sorted(k for k in official if k <= latest and k not in {d["date"] for d in new_daily})
    if extra:
        sys.exit(f"官方有、日線沒有的交易日：{extra}，中止")
    stats["daily"] = new_daily
    stats["source"] = "期交所期貨每日交易行情（TX 一般交易時段近月）；2026/11/16 起由期交所逐筆計算，兩者已比對一致"
    stats["method"] = "台指期日盤（08:45–13:45）近月契約最高價減最低價；結算日近月 13:30 收盤，改用次月。近N個交易日算術平均。"

    # 累積日高日低：契約與日線一致
    idx = U.load("index.json")
    for e in stats["cumulativeExtremes"]["daily"]:
        cs = {x["contract"]: None for x in idx if x["date"] == e["date"]}
        want = official[e["date"]]["contract"]
        if e["contract"] != want:
            t = U.load(f"{e['date']}_{want}.json")
            hi, lo, ht, lt = U.extremes_of(t["ticks"])
            print(f"{e['date']} 日高日低契約 {e['contract']} → {want}")
            e.update({"contract": want, "high": hi, "low": lo, "highTime": ht, "lowTime": lt,
                      "ticks": len(t["ticks"]), "sha256": t["sha256"]})
        assert want in cs
    stats["cumulativeExtremes"]["source"] = "期交所TX日盤逐筆；每日近月單一契約（結算日用次月）"
    U.dump("statistics.json", U.rebuild_stats(stats))
    print("完成：", len(new_daily), "天")


if __name__ == "__main__":
    main()
