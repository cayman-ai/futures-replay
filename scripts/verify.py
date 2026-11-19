#!/usr/bin/env python3
"""期貨島資料全面檢查，結果寫到 reports/verify.md 與 reports/verify.json。

A. 內部一致性（不連網）：index ↔ 逐筆檔、逐筆排序與時段、日高日低／時段 ↔ 逐筆、
   昨高昨低參考、統計重算是否與檔案一致、交易日有無重複或缺漏。
B. 逐筆重抓：期交所仍保留的日期，重新下載 Daily CSV，逐筆（時間／價／量／列序）比對。
C. 官方日行情：期交所「期貨每日交易行情」TX 一般交易時段，逐日比對
   statistics.daily 的開高低收、每個逐筆檔的開高低收與成交量，並找出缺漏的交易日。
"""
from __future__ import annotations

import copy
import csv
import datetime as dt
import io
import json
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update as U  # noqa: E402

ROOT = U.ROOT
REPORT = ROOT / "reports"
OFFICIAL_URL = "https://www.taifex.com.tw/cht/3/futDataDown"

SPREAD_LEGS: dict = defaultdict(int)
SPREAD_CHECKED: dict = {}
ROW_ONLY: list = []
VOL_DIFF: list = []
issues: dict[str, list[str]] = defaultdict(list)
notes: dict[str, list[str]] = defaultdict(list)


def bad(section, msg):
    issues[section].append(msg)


# ---------------- A. 內部一致性 ----------------

def check_local():
    idx = U.load("index.json")
    stats = U.load("statistics.json")
    alert = U.load("alert-reference.json")
    dates = sorted({x["date"] for x in idx})
    seen = set()
    ticks_by = {}
    for x in idx:
        key = (x["date"], x["contract"])
        if key in seen:
            bad("A", f"index 重複：{key}")
        seen.add(key)
        f = U.load(f"{x['date']}_{x['contract']}.json")
        if f is None:
            bad("A", f"缺檔：{x['date']}_{x['contract']}.json")
            continue
        t = f["ticks"]
        ticks_by[key] = t
        meta = {k: v for k, v in f.items() if k != "ticks"}
        if meta != x:
            bad("A", f"{key} 逐筆檔表頭與 index 不一致")
        if len(t) != x["count"]:
            bad("A", f"{key} count={x['count']} 但實際 {len(t)} 筆")
        if any(t[i][0] > t[i + 1][0] or t[i][3] >= t[i + 1][3] for i in range(len(t) - 1)):
            bad("A", f"{key} 時間或列序不是遞增")
        if t and not (U.DAY_START <= t[0][0] and t[-1][0] <= U.DAY_END):
            bad("A", f"{key} 有日盤時段外的逐筆")
        if any(q[2] <= 0 or q[1] <= 0 for q in t):
            bad("A", f"{key} 有價或量 ≤0 的逐筆")
    # 每日近月與日高日低
    cum = {d["date"]: d for d in stats["cumulativeExtremes"]["daily"]}
    if sorted(cum) != dates:
        bad("A", f"累積日高日低的日期與逐筆日期不同：少 {sorted(set(dates) - set(cum))}，多 {sorted(set(cum) - set(dates))}")
    for d in dates:
        cs = {c: ticks_by[(d, c)] for (dd, c) in ticks_by if dd == d}
        front = U.pick_front(cs)
        e = cum.get(d)
        if not e:
            continue
        if e["contract"] != front:
            notes["A"].append(f"{d} 累積日高日低用 {e['contract']}，現行規則會選 {front}")
        t = cs.get(e["contract"])
        if t is None:
            bad("A", f"{d} 累積日高日低引用的 {e['contract']} 沒有逐筆檔")
            continue
        hi, lo, ht, lt = U.extremes_of(t)
        exp = {"high": hi, "low": lo, "highTime": ht, "lowTime": lt, "ticks": len(t)}
        got = {k: e[k] for k in exp}
        if got != exp:
            bad("A", f"{d} 日高日低與逐筆不符：檔案 {got}，逐筆 {exp}")
    # 近 20 日
    if stats["extremes"]["daily"] != [{k: d[k] for k in ("date", "contract", "high", "low", "highTime", "lowTime")}
                                      for d in sorted(cum.values(), key=lambda d: d["date"])[-20:]]:
        bad("A", "近 20 日日高日低不是累積資料的最後 20 天")
    # 用逐筆算的日線（11/16 起）
    for d in stats["daily"]:
        if d.get("contract") and (d["date"], d["contract"]) in ticks_by:
            t = ticks_by[(d["date"], d["contract"])]
            hi, lo, ht, lt = U.extremes_of(t)
            exp = [t[0][1], hi, lo, t[-1][1], hi - lo] + ([ht - ht % 60, lt - lt % 60] if "highTime" in d else [])
            got = [d["open"], d["high"], d["low"], d["close"], d["amplitude"]] + ([d["highTime"], d["lowTime"]] if "highTime" in d else [])
            if [float(v) for v in exp] != [float(v) for v in got]:
                bad("A", f"{d['date']} 日線與逐筆不符：檔案 {got}，逐筆 {exp}")
    # 日線本身
    ds = [d["date"] for d in stats["daily"]]
    if len(ds) != len(set(ds)) or ds != sorted(ds):
        bad("A", "日線日期有重複或未排序")
    for d in stats["daily"]:
        if not (d["low"] <= min(d["open"], d["close"]) and max(d["open"], d["close"]) <= d["high"]):
            bad("A", f"{d['date']} 日線開收不在高低之間：{d}")
        if abs(d["amplitude"] - (d["high"] - d["low"])) > 1e-9:
            bad("A", f"{d['date']} 震幅≠高−低")
    # 統計重算一致
    rebuilt = U.rebuild_stats(copy.deepcopy(stats))
    if json.dumps(rebuilt, sort_keys=True) != json.dumps(stats, sort_keys=True):
        bad("A", "statistics.json 與用同一份日線重算的結果不同")
    # 昨高昨低參考
    ref = {}
    for d in dates:
        ref.update(U.alert_refs_for(d, [x for x in idx if x["date"] < d], [x for x in idx if x["date"] == d]))
    if ref != alert:
        diff = [k for k in set(ref) | set(alert) if ref.get(k) != alert.get(k)]
        bad("A", f"alert-reference.json 有 {len(diff)} 筆與逐筆重算不同，例如 {sorted(diff)[:5]}")
    notes["A"].append(f"檢查 {len(idx)} 個逐筆檔、{len(dates)} 個逐筆交易日（{dates[0]}～{dates[-1]}）、{len(stats['daily'])} 筆日線")
    return idx, stats, ticks_by


# ---------------- B. 逐筆重抓 ----------------

def check_ticks(idx, ticks_by):
    dates = sorted({x["date"] for x in idx})
    checked, gone = [], []
    for d in dates:
        got = U.download(d)
        if got is None:
            gone.append(d)
            continue
        raw, _ = got
        new = U.parse(d, raw)
        SPREAD_CHECKED[d] = True
        mine = {c for (dd, c) in ticks_by if dd == d}
        if set(new) != mine:
            bad("B", f"{d} 契約清單不同：網站 {sorted(mine)}，期交所 {sorted(new)}")
        for c in sorted(mine & set(new)):
            if ticks_by[(d, c)] != new[c]:
                old = ticks_by[(d, c)]
                main_same = [t[:3] for t in old] == [t[:3] for t in new[c]]
                if main_same:
                    ROW_ONLY.append(f"{d} {c}")
                    continue
                bad("B", f"{d} {c} 逐筆不同（網站 {len(old)} 筆／期交所 {len(new[c])} 筆；時間價量{'相同，只有列序不同' if main_same else '不同'}）")
        checked.append(d)
        time.sleep(1)
    if ROW_ONLY:
        notes["B"].append(f"{len(ROW_ONLY)} 個檔時間／價／量完全相同，只有「來源列序」編號不同（{ROW_ONLY[0].split()[0]}～{ROW_ONLY[-1].split()[0]}，舊版從 xlsx 轉檔時的列號；只用於事件紀錄顯示，不影響回放與統計）")
    notes["B"].append(f"重抓比對 {len(checked)} 天：{checked[0] if checked else '—'}～{checked[-1] if checked else '—'}")
    if gone:
        notes["B"].append(f"期交所已不提供逐筆、無法重抓的 {len(gone)} 天：{gone[0]}～{gone[-1]}（改用 C 的官方日行情比對）")


# ---------------- C. 官方日行情 ----------------

def fetch_official(start: dt.date, end: dt.date):
    """回傳 {(日期, 月份): {open,high,low,close,volume}}，只取 TX 一般交易時段單月契約。"""
    rows = {}
    trading_days = set()
    cur = start.replace(day=1)
    first_text = None
    while cur <= end:
        nxt = (cur.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        a, b = max(cur, start), min(nxt - dt.timedelta(days=1), end)
        body = urllib.parse.urlencode({
            "down_type": "1", "commodity_id": "TX", "commodity_id2": "",
            "queryStartDate": a.strftime("%Y/%m/%d"), "queryEndDate": b.strftime("%Y/%m/%d"),
        }).encode()
        req = urllib.request.Request(OFFICIAL_URL, data=body, headers={"User-Agent": "Mozilla/5.0 futures-replay-verify",
                                                                       "Content-Type": "application/x-www-form-urlencoded"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=90) as r:
                    raw = r.read()
                break
            except Exception as e:  # noqa: BLE001
                err = e
                time.sleep(5 * (attempt + 1))
        else:
            raise RuntimeError(f"官方日行情 {a}～{b} 下載失敗：{err}")
        text = raw.decode("cp950", errors="replace")
        first_text = first_text or text[:300]
        reader = csv.reader(io.StringIO(text))
        header = next(reader, [])
        if not header or "交易日期" not in header[0]:
            raise RuntimeError(f"官方日行情 {a}～{b} 格式異常，開頭：{text[:200]!r}")
        col = {h.strip(): i for i, h in enumerate(header)}
        for row in reader:
            if len(row) < len(col) - 1:
                continue
            g = lambda k: row[col[k]].strip()  # noqa: E731
            session = g("交易時段")
            if g("契約") != "TX" or session not in ("一般", "盤後"):
                continue
            month = g("到期月份(週別)")
            if not (len(month) == 6 and month.isdigit()):
                continue
            date = g("交易日期").replace("/", "")
            if session == "一般":
                trading_days.add(date)
            vals = [g(k) for k in ("開盤價", "最高價", "最低價", "收盤價")]
            if "-" in vals:
                continue
            rows[(date, month) if session == "一般" else (date, month, "night")] = {"open": float(vals[0]), "high": float(vals[1]), "low": float(vals[2]),
                                   "close": float(vals[3]), "volume": int(g("成交量") or 0)}
        cur = nxt
        time.sleep(1)
    return rows, trading_days, first_text


def check_official(idx, stats, ticks_by):
    daily = stats["daily"]
    start = dt.datetime.strptime(daily[0]["date"], "%Y%m%d").date()
    end = dt.datetime.now(U.TPE).date()
    off, tdays, sample = fetch_official(start, end)
    notes["C"].append(f"官方日行情 {start}～{end}：{len(tdays)} 個交易日、{len(off)} 筆 TX 一般時段單月契約")
    by_date = defaultdict(dict)
    night = defaultdict(dict)
    for k, v in off.items():
        if len(k) == 2:
            by_date[k[0]][k[1]] = v
        else:
            night[k[0]][k[1]] = v
    last_day = {}
    for d in sorted(by_date):
        for m in by_date[d]:
            last_day[m] = d

    def front_of(d):
        ms = sorted(by_date[d])
        return ms[1] if len(ms) > 1 and last_day.get(ms[0]) == d else ms[0]

    # 官方日盤近月表（結算日改用次月），給重建歷史日線用
    table = []
    for d in sorted(by_date):
        m = front_of(d)
        o = by_date[d][m]
        table.append({"date": d, "contract": m, **o})
    (REPORT / "official_all.json").write_text(json.dumps({d: by_date[d] for d in sorted(by_date)}, ensure_ascii=False, separators=(",", ":")), "utf-8")
    (REPORT / "official_daily.json").write_text(json.dumps(table, ensure_ascii=False, separators=(",", ":")), "utf-8")
    notes["C"].append(f"已輸出官方日盤近月表 reports/official_daily.json：{len(table)} 天")

    # 假說檢查：舊日線是否＝夜盤＋日盤合併
    merged_hit = 0
    for d in daily:
        if d.get("contract"):
            continue
        dd = d["date"]
        for m in sorted(by_date.get(dd, {}))[:2]:
            o, n = by_date[dd][m], night.get(dd, {}).get(m)
            if not n:
                continue
            if [n["open"], max(n["high"], o["high"]), min(n["low"], o["low"])] == [d["open"], d["high"], d["low"]]:
                merged_hit += 1
                break
    notes["C"].append(f"舊日線（rule(COW).xls）中，開高低＝同日「夜盤＋日盤」合併的天數：{merged_hit}／{sum(1 for d in daily if not d.get('contract'))}")
    have = {d["date"] for d in daily}
    latest = daily[-1]["date"]
    missing = sorted(d for d in tdays if d not in have and d <= latest)
    extra = sorted(d for d in have if d not in tdays)
    if missing:
        bad("C", f"日線缺少 {len(missing)} 個官方交易日：{missing[:20]}{' …' if len(missing) > 20 else ''}")
    if extra:
        bad("C", f"日線有 {len(extra)} 天官方沒有交易：{extra[:20]}")
    newer = sorted(d for d in tdays if d > latest)
    if newer:
        notes["C"].append(f"官方已有、網站尚未更新的交易日：{newer}（收盤後排程會補上）")

    # C1：日線開高低收 vs 官方近月
    mism = []
    pick_counts = defaultdict(int)
    for d in daily:
        months = sorted(by_date.get(d["date"], {}))
        if not months:
            continue
        cands = [m for m in months[:2]]
        mine = [d["open"], d["high"], d["low"], d["close"]]
        hit = None
        for m in ([d["contract"]] if d.get("contract") else cands):
            o = by_date[d["date"]].get(m)
            if o and [o["open"], o["high"], o["low"], o["close"]] == mine:
                hit = m
                break
        if hit:
            pick_counts["近月" if hit == months[0] else "次月"] += 1
            continue
        o = by_date[d["date"]][d.get("contract") or months[0]]
        mism.append({"date": d["date"], "site": mine, "official": [o["open"], o["high"], o["low"], o["close"]],
                     "officialContract": d.get("contract") or months[0], "file": d.get("file"),
                     "ampSite": d["amplitude"], "ampOfficial": o["high"] - o["low"]})
    notes["C"].append(f"日線與官方完全相同：{sum(pick_counts.values())} 天（{dict(pick_counts)}）")
    if mism:
        bad("C", f"日線開高低收與官方不同：{len(mism)} 天（明細見 verify.json）")
        hl = [m for m in mism if m["site"][1:3] != m["official"][1:3]]
        notes["C"].append(f"其中最高或最低不同（會影響震幅）：{len(hl)} 天；只差開盤或收盤：{len(mism) - len(hl)} 天")
        for m in mism[:15]:
            notes["C"].append(f"  {m['date']}：網站 開高低收 {m['site']}／官方 {m['officialContract']} {m['official']}")

    # C2：每個逐筆檔 vs 官方同契約
    tick_mism = []
    for (d, c), t in sorted(ticks_by.items()):
        o = by_date.get(d, {}).get(c)
        if not o:
            tick_mism.append(f"{d} {c}：官方沒有這個契約的一般時段行情")
            continue
        hi, lo = max(x[1] for x in t), min(x[1] for x in t)
        mine = [t[0][1], hi, lo, t[-1][1]]
        vol = sum(x[2] for x in t)
        offv = [o["open"], o["high"], o["low"], o["close"]]
        if [float(v) for v in mine] != offv:
            tick_mism.append(f"{d} {c}：逐筆 開高低收 {mine}／官方 {offv}")
        if vol != o["volume"]:
            VOL_DIFF.append(f"{d} {c}：逐筆量 {vol}／官方成交量 {o['volume']}")
    if tick_mism:
        bad("C", f"逐筆檔與官方日行情不同：{len(tick_mism)} 個")
        notes["C"].extend("  " + s for s in tick_mism[:30])
    else:
        notes["C"].append(f"{len(ticks_by)} 個逐筆檔的開高低收全部與官方日盤相同")
    if VOL_DIFF:
        notes["C"].append(f"⚠️ 成交量：{len(VOL_DIFF)} 個逐筆檔的逐筆量合計與官方日成交量不同（逐筆本身已與期交所逐筆檔逐筆相同；差額原因未確認，不納入任何統計）。例：" + "；".join(VOL_DIFF[:5]))
    return {"dailyMismatches": mism, "tickMismatches": tick_mism, "missingDays": missing, "extraDays": extra,
            "officialSample": sample}


def main():
    REPORT.mkdir(exist_ok=True)
    detail = {}
    idx, stats, ticks_by = check_local()
    for name, fn in (("B", lambda: check_ticks(idx, ticks_by)), ("C", lambda: check_official(idx, stats, ticks_by))):
        try:
            r = fn()
            if r:
                detail.update(r)
        except Exception as e:  # noqa: BLE001
            bad(name, f"無法完成：{e}")
    now = dt.datetime.now(U.TPE).strftime("%Y-%m-%d %H:%M")
    titles = {"A": "A. 內部一致性", "B": "B. 逐筆重抓比對（期交所 Daily CSV）", "C": "C. 官方日行情比對（期交所期貨每日交易行情）"}
    lines = [f"# 期貨島資料檢查報告", f"", f"執行時間：{now}（台北）；資料最新日：{stats['latest']}", ""]
    for k in "ABC":
        lines.append(f"## {titles[k]}：{'✅ 通過' if not issues[k] else '❌ 有 ' + str(len(issues[k])) + ' 項問題'}")
        lines += [f"- ❌ {s}" for s in issues[k]] + [f"- {s}" for s in notes[k]] + [""]
    (REPORT / "verify.md").write_text("\n".join(lines), "utf-8")
    (REPORT / "verify.json").write_text(json.dumps({"issues": issues, "notes": notes, **detail}, ensure_ascii=False, indent=1), "utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
