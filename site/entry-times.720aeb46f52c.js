const START=31500,END=49500,MIN_SAMPLE=20;
const clock=s=>`${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s%3600/60)).padStart(2,'0')}`;
const fmt=(v,d=1)=>Number.isFinite(v)?v.toLocaleString('zh-TW',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const percent=v=>Number.isFinite(v)?fmt(v*100)+'%':'無法判定';
export function entryTimeAnalysis(records,{scope='all',mode='manual'}={}){
 let sessions=records.filter(r=>!r.deleted&&(mode==='all'||(mode==='auto'?r.cfg?.auto===true:r.cfg?.auto!==true))).slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))||String(b.id).localeCompare(String(a.id)));
 if(scope==='recent20')sessions=sessions.slice(0,20);
 const buckets=Array.from({length:11},(_,i)=>({start:START+i*1800,end:Math.min(END,START+(i+1)*1800-1),count:0,wins:0,losses:0,stops:0,unknownStop:0,profit:0,loss:0,net:0}));let incomplete=0,invalid=0;
 for(const record of sessions){
  const orders=new Map((record.orders??[]).map(o=>[o.id,o])),groups=new Map();
  for(const trade of record.trades??[]){
   if(!Number.isFinite(trade.net)||!Number.isFinite(trade.entryTime)||trade.entryTime<START||trade.entryTime>END||!Number.isFinite(trade.qty)||trade.qty<=0){invalid++;continue}
   const id=trade.entryOrder!=null?'order:'+trade.entryOrder:trade.entryRow!=null?'row:'+trade.entryRow:null;
   if(id===null){invalid++;continue}
   let group=groups.get(id);if(!group){group={id,order:orders.get(trade.entryOrder),row:trade.entryRow,time:trade.entryTime,qty:0,net:0,stop:false,unknownStop:false};groups.set(id,group)}
   if(group.time!==trade.entryTime){group.invalid=true;continue}
   group.qty+=trade.qty;group.net+=trade.net;group.stop ||= trade.reason==='停損'||trade.reason==='閃電停損';group.unknownStop ||= typeof trade.reason!=='string'||!trade.reason.trim();
  }
  const openIds=new Set();for(const lot of record.position?.lots??[]){const id=lot.entryOrder!=null?'order:'+lot.entryOrder:lot.row!=null?'row:'+lot.row:null;if(lot.qty>0&&id&&!groups.has(id))openIds.add(id)}incomplete+=openIds.size;
  // Count a partially closed entry once, only after its entire opened quantity is closed.
  for(const group of groups.values()){
   if(group.invalid){invalid++;continue}
   const expected=group.order?.openQty;
   const remaining=(record.position?.lots??[]).some(l=>l.qty>0&&((l.entryOrder!=null&&group.id==='order:'+l.entryOrder)||(l.row!=null&&group.row===l.row)));
   let complete=false;
   if(Number.isFinite(expected)&&expected>0){if(group.qty>expected){invalid++;continue}complete=group.qty===expected&&!remaining}
   else complete=!remaining&&(record.position===null||record.finished===true||Array.isArray(record.position?.lots));
   if(!complete){incomplete++;continue}
   const b=buckets[Math.floor((group.time-START)/1800)];b.count++;b.net+=group.net;if(group.net>0){b.wins++;b.profit+=group.net}else if(group.net<0){b.losses++;b.loss-=group.net}if(group.stop)b.stops++;else if(group.unknownStop)b.unknownStop++;
  }
 }
 for(const b of buckets){b.label=b.start===END?'13:45（收盤）':clock(b.start)+'～'+clock(b.end);b.winRate=b.count?b.wins/b.count:null;b.lossRate=b.count?b.losses/b.count:null;b.stopRate=b.count&&!b.unknownStop?b.stops/b.count:null;b.average=b.count?b.net/b.count:null;b.payoff=b.wins&&b.losses?(b.profit/b.wins)/(b.loss/b.losses):null;b.eligible=b.count>=MIN_SAMPLE}
 const rank=(metric,highest)=>{const candidates=buckets.filter(b=>b.eligible&&Number.isFinite(b[metric]));if(!candidates.length)return null;const value=(highest?Math.max:Math.min)(...candidates.map(b=>b[metric]));return {value,labels:candidates.filter(b=>Math.abs(b[metric]-value)<1e-10).map(b=>b.label)}};
 return {scope,mode,sessions:sessions.length,total:buckets.reduce((n,b)=>n+b.count,0),incomplete,invalid,minSample:MIN_SAMPLE,buckets,ranks:{winHigh:rank('winRate',true),winLow:rank('winRate',false),stopHigh:rank('stopRate',true),payoffHigh:rank('payoff',true),payoffLow:rank('payoff',false),averageHigh:rank('average',true)}};
}
function rateChart(s){const width=800,height=220,left=38,base=178,step=68;return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="進場時段勝率與停損率"><g stroke="#2a3b44">${[0,.5,1].map(v=>`<path d="M${left} ${base-v*140}H790"/><text x="0" y="${base-v*140+4}" fill="#8fa4af" stroke="none" font-size="10">${v*100}%</text>`).join('')}</g>${s.buckets.map((b,i)=>{const x=left+i*step+4;return `<g opacity="${b.eligible?1:.45}">${[['winRate','#d9bd79',0],['stopRate','#68bfa9',22]].map(([key,color,offset])=>Number.isFinite(b[key])?`<rect x="${x+offset}" y="${base-b[key]*140}" width="18" height="${b[key]*140}" fill="${color}"><title>${b.label} ${key==='winRate'?'勝率':'停損率'} ${percent(b[key])}，${b.count}次出手</title></rect>`:'').join('')}<text x="${x}" y="198" fill="#8fa4af" font-size="10">${clock(b.start)}</text></g>`}).join('')}</svg>`}
export function entryTimeHTML(s){
 const cards=[['勝率最高',s.ranks.winHigh,percent],['勝率最低',s.ranks.winLow,percent],['停損率最高',s.ranks.stopHigh,percent],['平均盈虧比最高',s.ranks.payoffHigh,v=>fmt(v,2)],['平均盈虧比最低',s.ranks.payoffLow,v=>fmt(v,2)],['每次平均損益最高',s.ranks.averageHigh,v=>fmt(v,0)+' 元']];
 return `<details class="statDisclosure"><summary>出手時段分析</summary><div class="disclosureBody"><div class="sectionhead"><div class="entryTimeFilters"><label>範圍<select id="entryTimeScope"><option value="all" ${s.scope==='all'?'selected':''}>全部紀錄</option><option value="recent20" ${s.scope==='recent20'?'selected':''}>最近20次練習</option></select></label><label>模式<select id="entryTimeMode"><option value="manual" ${s.mode==='manual'?'selected':''}>手動練習</option><option value="all" ${s.mode==='all'?'selected':''}>全部模式</option><option value="auto" ${s.mode==='auto'?'selected':''}>自動練習</option></select></label></div></div><p class="historyScope">${s.sessions} 次已儲存練習，${s.total} 次完整平倉出手。依進場成交時間每30分鐘分組；同一筆進場的分批出場合併為一次，加碼視為另一次出手。未完整平倉 ${s.incomplete} 組、資料不足或異常 ${s.invalid} 筆未計入。</p><div class="statsgrid explainedStats">${cards.map(([label,r,format])=>`<div><span>${label}</span><strong>${r?format(r.value):'資料不足'}</strong><p>${r?r.labels.join('、'):`每個時段至少 ${s.minSample} 次完整出手，且指標可計算才排名。`}</p></div>`).join('')}</div><details class="chartDisclosure"><summary>查看勝率／停損率分布圖</summary><div class="entryTimeChart"><p>金色＝勝率　綠色＝停損率；淡色表示未滿 ${s.minSample} 次，僅供參考。</p>${rateChart(s)}</div></details><div class="statisticsTable"><table><thead><tr><th>進場時段</th><th>完整出手次數</th><th>勝率</th><th>虧損率</th><th>停損率</th><th>平均盈虧比</th><th>每次平均損益</th><th>排名樣本</th></tr></thead><tbody>${s.buckets.map(b=>`<tr><td>${b.label}</td><td>${b.count}</td><td>${b.count?percent(b.winRate):'—'}</td><td>${b.count?percent(b.lossRate):'—'}</td><td>${b.count?percent(b.stopRate):'—'}</td><td>${Number.isFinite(b.payoff)?fmt(b.payoff,2):'—'}</td><td>${b.count?fmt(b.average,0)+' 元':'—'}</td><td>${b.eligible?'足夠':'不足20次'}</td></tr>`).join('')}</tbody></table></div><p class="historyScope">勝率按扣除成本後淨損益大於0計；停損率按出場理由為停損／閃電停損計，曾有一部分因停損出場即算一次，不等同虧損率。缺少出場理由時停損率顯示無法判定。盈虧比＝平均獲利 ÷ 平均虧損絕對值，兩者都有才計算。最近20次依保存建立時間選取；不含回收筒，匯入副本個別計入，與下方搜尋無關。個人紀錄僅在本瀏覽器計算。</p></div></details>`;
}
