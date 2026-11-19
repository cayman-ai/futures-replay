const fmt=(v,d=0)=>Number.isFinite(v)?v.toLocaleString('zh-TW',{maximumFractionDigits:d,minimumFractionDigits:d}):'—';
export function performanceHTML(s){
 const cards=[
 ['累積損益',fmt(s.net)+' 元','扣除手續費、稅與模擬滑價後的總損益，包含目前未平倉的浮動損益。'],
 ['最大回撤（MDD）',fmt(s.mdd)+' 元','權益從先前高點回落至後續低點的最大金額，包含浮動損益。'],
 ['勝率',s.winRate==null?'—':fmt(s.winRate*100,1)+'%','已平倉獲利交易筆數 ÷ 全部已平倉交易筆數。'],
 ['平均盈虧比',fmt(s.payoff,2),'平均每筆獲利 ÷ 平均每筆虧損的絕對值；兩類都存在才計算。'],
 ['每筆交易期望值',s.expectancy==null?'—':fmt(s.expectancy,1)+' 元','已平倉交易的淨損益合計 ÷ 已平倉交易筆數，不混入浮動損益。'],
 ['獲利因子（Profit Factor）',s.pf===Infinity?'∞（尚無虧損）':fmt(s.pf,2),'所有獲利交易的淨利合計 ÷ 所有虧損交易的淨損絕對值。'],
 ['最大連續虧損次數',fmt(s.maxStreak)+' 次','已平倉交易中，連續發生虧損的最長次數。'],
 ['年複合報酬率（CAGR）','暫不計算','待本金、加減資與完整投資期間確定後計算；單日績效不直接年化。'],
 ['已平倉交易筆數',fmt(s.count)+' 筆','按先進先出配對計算；分批進出可能形成多筆配對交易。'],
 ['回撤恢復時間',s.recovery==null?'尚未恢復':fmt(s.recovery)+' 秒','權益從前次高點回落，到再次回到該高點所需的最長模擬時間。']
 ];
 return '<div class="statsgrid explainedStats">'+cards.map(([label,value,description])=>`<div><span>${label}</span><strong>${value}</strong><p>${description}</p></div>`).join('')+'</div>';
}

// New saves of the same replay update its own record, never unrelated history.
export class SessionArchive {
 constructor(){this.records=new WeakMap()}
 get(session){return this.records.get(session)}
 has(session){return this.records.has(session)}
 async put(session,snapshot,persist){const previous=this.get(session),record={...snapshot};if(previous){record.id=previous.id;record.createdAt=previous.createdAt}await persist(record);this.records.set(session,{id:record.id,createdAt:record.createdAt,name:record.name});return record}
}
