#!/usr/bin/env python3
"""期貨島每日資料更新。

從期交所「前 30 個交易日期貨每筆成交資料」下載 Daily_YYYY_MM_DD.zip，
把 TX 日盤（08:45–13:45）逐筆轉成網站用的 JSON，並重算 alert-reference.json、statistics.json。

- 冪等：已有的日期不重做；缺幾天補幾天（期交所只保留近 30 個交易日）。
- 任何驗證失敗就以非 0 結束，不寫入半套資料。

用法：
  python scripts/update.py                 # 補齊缺的日期
  python scripts/update.py --rebuild-stats  # 只用現有資料重算統計（驗證用）
  python scripts/update.py --check 20261117 # 重新下載某日並與現有檔比對（驗證轉換邏輯）
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
TPE = dt.timezone(dt.timedelta(hours=8))
SOURCE_PAGE = "https://www.taifex.com.tw/cht/3/futPrevious30DaysSalesData"
ZIP_URL = "https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/Daily_{y}_{m}_{d}.zip"
DAY_START, DAY_END = 8 * 3600 + 45 * 60, 13 * 3600 + 45 * 60
VOLUME_DIVISOR = 2  # 期交所欄位是「成交數量(B+S)」，買賣各算一次
ROW_BASE = 1  # ticks[i][3]＝該筆在 CSV 的列序；由 --check 對照既有資料確認
BUCKET = 900
LOOKBACK_DAYS = 50  # 往回找缺漏的日曆天數（約涵蓋期交所保留的 30 個交易日）


def load(name, default=None):
    p = DATA / name
    return json.loads(p.read_text("utf-8")) if p.exists() else default


def dump(name, obj):
    p = DATA / name
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), "utf-8")
    tmp.replace(p)


# ---------- 下載與解析 ----------

def download(date: str) -> tuple[bytes, str] | None:
    """回傳 (csv bytes, 下載網址)；當天沒有檔案（假日或尚未公布）回傳 None。"""
    url = ZIP_URL.format(y=date[:4], m=date[4:6], d=date[6:])
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 futures-replay-updater"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            err = e
        except Exception as e:  # 網路暫時錯誤
            err = e
        time.sleep(5 * (attempt + 1))
    else:
        raise RuntimeError(f"{date} 下載失敗：{err}")
    if not body.startswith(b"PK"):
        return None  # 期交所對不存在的日期常回 HTML 頁面
    with zipfile.ZipFile(io.BytesIO(body)) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".csv")]
        if len(names) != 1:
            raise RuntimeError(f"{date} 壓縮檔內 CSV 數量異常：{z.namelist()}")
        return z.read(names[0]), url


def parse(date: str, raw: bytes) -> dict[str, list[list[int]]]:
    """回傳 {契約月份: [[秒, 價, 量, 列序], ...]}，只含 TX 單月契約日盤。"""
    text = raw.decode("cp950", errors="strict")
    out: dict[str, list[list[int]]] = {}
    reader = csv.reader(io.StringIO(text))
    header = next(reader)
    if len(header) < 6 or "成交" not in header[0]:
        raise RuntimeError(f"{date} CSV 表頭異常：{header}")
    for i, row in enumerate(reader):
        if len(row) < 6:
            continue
        if row[1].strip() != "TX" or row[0].strip() != date:
            continue
        month = row[2].strip()
        if not (len(month) == 6 and month.isdigit()):
            continue  # 排除價差、週契約
        hhmmss = int(row[3].strip())
        sec = hhmmss // 10000 * 3600 + hhmmss // 100 % 100 * 60 + hhmmss % 100
        if not DAY_START <= sec <= DAY_END:
            continue
        price = float(row[4].strip())
        qty = int(row[5].strip())
        if price != int(price) or qty % VOLUME_DIVISOR:
            raise RuntimeError(f"{date} 第 {i + ROW_BASE} 列數值異常：{row}")
        out.setdefault(month, []).append([sec, int(price), qty // VOLUME_DIVISOR, i + ROW_BASE])
    for m, ticks in out.items():
        if any(ticks[k][0] > ticks[k + 1][0] for k in range(len(ticks) - 1)):
            raise RuntimeError(f"{date} {m} 時間順序異常")
    return out


# ---------- 寫入一個交易日 ----------

def contract_files(date, contracts, sha, url, index):
    prev_date = max((x["date"] for x in index if x["date"] < date), default=None)
    prev_close = {}
    if prev_date:
        for x in index:
            if x["date"] == prev_date:
                t = load(f"{prev_date}_{x['contract']}.json")["ticks"]
                prev_close[x["contract"]] = t[-1][1]
    entries, files = [], {}
    for month in sorted(contracts):
        ticks = contracts[month]
        meta = {
            "date": date, "contract": month, "count": len(ticks),
            "previousClose": prev_close.get(month),
            "previousDate": prev_date if month in prev_close else None,
            "sha256": sha, "file": f"Daily_{date[:4]}_{date[4:6]}_{date[6:]}.csv",
            "source": SOURCE_PAGE, "downloadURL": url,
            "sourceFormat": "TAIFEX CSV", "volumeDivisor": VOLUME_DIVISOR,
        }
        entries.append(meta)
        files[f"{date}_{month}.json"] = {**meta, "ticks": ticks}
    return entries, files


def pick_front(contracts):
    """最近月份契約；結算日近月 13:30 就收盤，改用下一個交易到 13:45 的契約（與 Dropbox 逐日 Excel 一致）。"""
    full = [m for m in sorted(contracts) if contracts[m][-1][0] > 13 * 3600 + 30 * 60]
    return full[0] if full else min(contracts)


def extremes_of(ticks):
    hi = max(t[1] for t in ticks)
    lo = min(t[1] for t in ticks)
    return hi, lo, next(t[0] for t in ticks if t[1] == hi), next(t[0] for t in ticks if t[1] == lo)


def add_day(date, contracts, sha, url, fetched_at):
    index = load("index.json", [])
    if any(x["date"] == date for x in index):
        return False
    entries, files = contract_files(date, contracts, sha, url, index)
    front = pick_front(contracts)
    ticks = contracts[front]
    if len(ticks) < 1000:
        raise RuntimeError(f"{date} 近月 {front} 只有 {len(ticks)} 筆，疑似資料不完整")
    hi, lo, hit, lot = extremes_of(ticks)

    stats = load("statistics.json")
    roll = {}
    last = stats["daily"][-1]
    if last.get("contract") != front:
        prev_date = max((x["date"] for x in index if x["date"] < date), default=None)
        pf = load(f"{prev_date}_{front}.json") if prev_date else None
        if pf and pf["ticks"]:
            roll = {"prevHigh": float(max(t[1] for t in pf["ticks"])), "prevLow": float(min(t[1] for t in pf["ticks"]))}
        else:
            roll = {"prevHigh": None, "prevLow": None}
    stats["daily"].append({**roll,
        "date": date, "contract": front, "open": float(ticks[0][1]), "high": float(hi),
        "low": float(lo), "close": float(ticks[-1][1]), "amplitude": float(hi - lo),
        "highTime": hit - hit % 60, "lowTime": lot - lot % 60,
        "minutes": len({t[0] // 60 for t in ticks}),
        "file": entries[0]["file"], "sha256": sha, "sourcePath": url, "modified": fetched_at,
    })
    stats["cumulativeExtremes"]["daily"].append({
        "date": date, "contract": front, "high": hi, "low": lo,
        "highTime": hit, "lowTime": lot, "ticks": len(ticks), "sha256": sha,
    })
    stats = rebuild_stats(stats)

    alert = load("alert-reference.json", {})
    alert.update(alert_refs_for(date, index, entries))

    for name, obj in files.items():
        dump(name, obj)
    dump("index.json", index + entries)
    dump("alert-reference.json", alert)
    dump("statistics.json", stats)
    return True


def alert_refs_for(date, index, entries):
    """key＝今日_契約；值＝該契約前一交易日的日盤高低。"""
    prev_date = max((x["date"] for x in index if x["date"] < date), default=None)
    refs = {}
    if not prev_date:
        return refs
    prev = {x["contract"] for x in index if x["date"] == prev_date}
    for e in entries:
        if e["contract"] in prev:
            t = load(f"{prev_date}_{e['contract']}.json")["ticks"]
            refs[f"{date}_{e['contract']}"] = {"date": prev_date, "high": max(x[1] for x in t), "low": min(x[1] for x in t)}
    return refs


# ---------- 統計重算 ----------

def avg(xs):
    return sum(xs) / len(xs)


def buckets(daily):
    out = []
    for start in range(DAY_START, DAY_END, BUCKET):
        out.append({"start": start, "end": start + BUCKET - 1, "high": 0, "low": 0})
    out.append({"start": DAY_END, "end": DAY_END, "high": 0, "low": 0})
    for d in daily:
        for key, t in (("high", d["highTime"]), ("low", d["lowTime"])):
            i = len(out) - 1 if t >= DAY_END else (t - DAY_START) // BUCKET
            out[i][key] += 1
    return out


def rebuild_stats(s):
    daily = sorted(s["daily"], key=lambda d: d["date"])
    amps = [d["amplitude"] for d in daily]
    dates = [d["date"] for d in daily]
    s["daily"] = daily
    s["count"] = len(daily)
    s["from"], s["latest"] = dates[0], dates[-1]
    s["availableAverage"] = avg(amps)
    s["windows"] = []
    for n in (20, 60, 120):
        have = min(n, len(amps))
        s["windows"].append({
            "days": n, "count": have, "missing": n - have,
            "average": round(avg(amps[-n:]), 2) if have == n else None,
            "from": dates[-have], "to": dates[-1],
        })
    s["history"] = [
        {"date": dates[i], "amplitude": amps[i],
         **{str(n): (avg(amps[i - n + 1:i + 1]) if i + 1 >= n else None) for n in (20, 60, 120)}}
        for i in range(len(daily))
    ]
    cum = s["cumulativeExtremes"]
    cdaily = sorted(cum["daily"], key=lambda d: d["date"])
    cum.update({"daily": cdaily, "count": len(cdaily), "complete": True,
                "from": cdaily[0]["date"], "to": cdaily[-1]["date"], "buckets": buckets(cdaily)})
    recent = [{k: d[k] for k in ("date", "contract", "high", "low", "highTime", "lowTime")} for d in cdaily[-20:]]
    s["extremes"] = {"days": 20, "count": len(recent), "selected": len(recent), "complete": len(recent) == 20,
                     "from": recent[0]["date"], "to": recent[-1]["date"], "daily": recent, "buckets": buckets(recent)}
    s["previousRange"] = previous_range(daily, s["previousRange"])
    return s


def previous_range(daily, old):
    latest = dt.datetime.strptime(daily[-1]["date"], "%Y%m%d").date()
    try:
        start = latest.replace(year=latest.year - old.get("years", 3))
    except ValueError:  # 2/29
        start = latest.replace(year=latest.year - old.get("years", 3), day=28)
    start_s = start.strftime("%Y%m%d")
    levels = [p["points"] for p in old["up"]["points"]]
    considered = skipped = inside = 0
    ups, downs = [], []
    first = None
    for prev, d in zip(daily, daily[1:]):
        if d["date"] <= start_s:
            continue
        first = first or d["date"]
        # 昨高昨低一律取「同一個契約」前一交易日的日盤高低；換月日用 prevHigh／prevLow
        if d.get("contract") and prev.get("contract") and d["contract"] != prev["contract"]:
            ph, pl = d.get("prevHigh"), d.get("prevLow")
        else:
            ph, pl = prev.get("high"), prev.get("low")
        if any(d.get(k) is None for k in ("open", "high", "low")) or ph is None or pl is None:
            skipped += 1
            continue
        considered += 1
        if not pl < d["open"] < ph:
            continue
        inside += 1
        if d["high"] > ph:
            ups.append(d["high"] - ph)
        if d["low"] < pl:
            downs.append(pl - d["low"])

    def side(xs):
        return {"count": len(xs), "points": [
            {"points": p, "count": sum(x >= p for x in xs), "percent": (sum(x >= p for x in xs) / len(xs) * 100) if xs else None}
            for p in levels]}

    return {"version": old.get("version", 1), "years": old.get("years", 3), "from": first, "to": daily[-1]["date"],
            "considered": considered, "skipped": skipped, "inside": inside, "up": side(ups), "down": side(downs)}


# ---------- 主流程 ----------

def missing_dates(today):
    have = {x["date"] for x in load("index.json", [])}
    last = max(have)
    out = []
    for k in range(LOOKBACK_DAYS, -1, -1):
        d = today - dt.timedelta(days=k)
        s = d.strftime("%Y%m%d")
        if s > last and d.weekday() < 5 and s not in have:
            out.append(s)
    return out


def run_update():
    now = dt.datetime.now(TPE)
    added = []
    for date in missing_dates(now.date()):
        got = download(date)
        if got is None:
            print(f"{date}：期交所沒有檔案（假日或尚未公布），略過")
            continue
        raw, url = got
        contracts = parse(date, raw)
        if not contracts:
            print(f"{date}：沒有 TX 日盤成交，略過")
            continue
        sha = hashlib.sha256(raw).hexdigest()
        fetched = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if add_day(date, contracts, sha, url, fetched):
            added.append(date)
            print(f"{date}：新增 {', '.join(f'{m}({len(t)})' for m, t in sorted(contracts.items()))}")
    latest = max(x["date"] for x in load("index.json"))
    if added:
        dump("updated.json", {"dataDate": latest, "updatedAt": dt.datetime.now(TPE).strftime("%Y-%m-%dT%H:%M:%S+08:00")})
    print(f"完成。新增 {len(added)} 天；目前最新資料日：{latest}")
    return added


def run_check(date):
    """重新下載某日，跟網站現有檔案逐欄比對；用來確認轉換邏輯與舊資料一致。"""
    got = download(date)
    if got is None:
        sys.exit(f"{date} 期交所已無檔案，無法比對")
    raw, url = got
    contracts = parse(date, raw)
    ok = True
    sha = hashlib.sha256(raw).hexdigest()
    for x in [x for x in load("index.json") if x["date"] == date]:
        old = load(f"{date}_{x['contract']}.json")
        new = contracts.get(x["contract"], [])
        if old["sha256"] != sha:
            print(f"注意：{date} CSV sha256 不同（舊 {old['sha256'][:12]} / 新 {sha[:12]}）")
        same_main = [t[:3] for t in old["ticks"]] == [t[:3] for t in new]
        offset = {o[3] - n[3] for o, n in zip(old["ticks"], new)} if same_main else set()
        print(f"{date} {x['contract']}: 舊 {len(old['ticks'])} 筆 / 新 {len(new)} 筆；時間價量一致={same_main}；列序差={sorted(offset)[:5]}")
        ok &= same_main and offset == {0}
    extra = set(contracts) - {x["contract"] for x in load("index.json") if x["date"] == date}
    if extra:
        print(f"新程式多出契約：{sorted(extra)}")
        ok = False
    print("比對結果：", "完全一致" if ok else "有差異")
    sys.exit(0 if ok else 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild-stats", action="store_true")
    ap.add_argument("--check")
    a = ap.parse_args()
    if a.check:
        run_check(a.check)
    elif a.rebuild_stats:
        dump("statistics.json", rebuild_stats(load("statistics.json")))
    else:
        run_update()


if __name__ == "__main__":
    main()
