# 曾阿牛的期貨島｜模擬交易

台指期（TX）日盤逐筆回放與模擬交易。純靜態網站，放在 GitHub Pages：
https://cayman-ai.github.io/futures-replay/

## 資料怎麼更新

- `.github/workflows/update.yml` 每個交易日台北時間 16:17、18:47、21:23 自動執行。
- `scripts/update.py` 從期交所「前 30 個交易日期貨每筆成交資料」下載 `Daily_YYYY_MM_DD.zip`，
  只取 TX 單月契約、日盤 08:45–13:45，寫入 `site/data/`，並重算 `statistics.json`、`alert-reference.json`。
- 缺幾天補幾天、已有的日期不重做。期交所只保留近 30 個交易日，停擺超過約 6 週就補不回來。
- 驗證失敗（下載失敗、近月筆數過少、格式異常）就不提交、不發布。

手動補跑：GitHub → Actions → 「每日更新期貨資料並發布」→ Run workflow。

資料來源：臺灣期貨交易所 https://www.taifex.com.tw/cht/3/futPrevious30DaysSalesData
2026/11/17 以前的資料與統計（含 2019 起的日線震幅）由原 chatgpt.site 版本搬入。
