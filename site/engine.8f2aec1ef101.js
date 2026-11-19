export class Replay {
 constructor(data,cfg={}) {this.data=data;this.cfg={capital:1000000,multiplier:200,fee:0,taxRate:0,slip:1,qty:1,tp:100,sl:50,offset:31,auto:false,...cfg};if(this.cfg.auto&&Math.floor(data.ticks[0][0]/60)!==525)throw Error('此契約缺少08:45開盤成交，請改選手動練習或其他契約');this.i=-1;this.orders=[];this.events=[];this.trades=[];this.bars=[];this.position=null;this.high=null;this.low=null;this.volume=0;this.realized=0;this.costs=0;this.equity=[];this.used={1:false,'-1':false};this.finished=false;this.seq=0;this.protectionPlans=[];this.protection=null;}
 get tick(){return this.data.ticks[this.i]}
 get unrealized(){return this.position&&this.tick?(this.tick[1]-this.position.price)*this.position.side*this.position.qty*this.cfg.multiplier:0}
 get net(){return this.realized-this.costs+this.unrealized}
 event(type,o,extra={}){this.events.push({type,index:this.i,time:this.tick?.[0]??null,row:this.tick?.[3]??null,order:o?.id??null,...extra})}
 submit({side=1,qty=1,close=false,condition=null,level=null,reason='手動',flatOnly=false,touch=false,kind='market',tp=this.cfg.tp,sl=this.cfg.sl}={}){
  if(this.finished)throw Error('本日已結束，請另開練習');
  if(touch){if(!this.tick)throw Error('請先載入行情');if(level===this.tick[1])throw Error('觸價等於現價，請改用現價單或設定其他價位');condition=level>this.tick[1]?'gte':'lte'}
  if(![1,-1].includes(side)||!Number.isInteger(qty)||qty<1||(!close&&qty>100)||![tp,sl].every(v=>Number.isFinite(v)&&v>=0))throw Error('請檢查方向、口數與停利停損');
  if(!['market','limit'].includes(kind))throw Error('不支援的委託種類');
  if(kind==='limit'&&(!Number.isInteger(level)||level<=0||condition))throw Error('限價請填入正整數');
  if(condition&&!['gte','lte'].includes(condition)||condition&&(!Number.isFinite(level)||level<=0||!Number.isInteger(level)))throw Error('請輸入有效整數觸價');
  if(flatOnly&&this.position)throw Error('觸價進場僅能於空手時設定');
  if(close&&!this.position)throw Error('目前沒有持倉');
  if(this.cfg.auto&&!close&&(this.position||this.orders.some(o=>!o.close&&['waiting','ready'].includes(o.status))))throw Error('策略已有持倉或進場委託');
  if(close&&this.orders.some(o=>o.close&&['waiting','ready'].includes(o.status)))throw Error('已有出場委託，請先取消');
  const o={id:++this.seq,side:close?-this.position.side:side,qty:close?Math.min(qty,this.position.qty):qty,close,flatOnly,touch,kind,condition,level,reason,tp,sl,submitted:this.i,status:(condition||kind==='limit')?'waiting':'ready',ready:this.i,submittedRow:this.tick?.[3]??null};this.orders.push(o);this.event('下單',o,{side:o.side,qty:o.qty,level,reason});return o;
 }
 cancel(id){const o=this.orders.find(o=>o.id===id);if(o&&['waiting','ready'].includes(o.status)){o.status='cancelled';if(o.protectionId&&this.protection?.id===o.protectionId)this.protection.status='cancelled';this.event('取消',o)}}
 cancelAll(){const pending=this.orders.filter(o=>['waiting','ready'].includes(o.status)),protection=!!this.protection&&['waiting-position','active','triggered'].includes(this.protection.status);this.cancelProtection();for(const o of pending)this.cancel(o.id);this.event('刪除全部未成交委託',null,{orders:pending.length,protection});return {orders:pending.length,protection};}
 modify(id,level){const o=this.orders.find(o=>o.id===id);if(!o||o.status!=='waiting')throw Error('僅未觸發委託可修改');if(!Number.isInteger(level)||level<=0)throw Error('觸價須為正整數');if(o.touch&&level===this.tick[1])throw Error('觸價等於現價，請改用現價單或設定其他價位');this.event('修改',o,{oldLevel:o.level,level});o.level=level;if(o.touch)o.condition=level>this.tick[1]?'gte':'lte';o.submitted=this.i;}
 refreshPosition(){
  const p=this.position;if(!p)return;
  p.lots=p.lots.filter(l=>l.qty>0);p.qty=p.lots.reduce((n,l)=>n+l.qty,0);
  if(!p.qty){this.position=null;return}
  p.price=p.lots.reduce((n,l)=>n+l.price*l.qty,0)/p.qty;p.cost=p.lots.reduce((n,l)=>n+l.cost,0);
 }
 cancelExits(except){for(const other of this.orders)if(other!==except&&other.close&&['waiting','ready'].includes(other.status)){other.status='cancelled';this.event('部位結束取消',other)}}
 fill(o,forced=false){
  const t=this.tick;
  if(o.flatOnly&&this.position){o.status='cancelled';this.event('非空手取消觸價進場',o);return}
  if(o.close&&(!this.position||o.side!==-this.position.side)){o.status='cancelled';this.event('部位已變更取消',o);return}
  const slipped=t[1]+o.side*this.cfg.slip,price=o.kind==='limit'?(o.side===1?Math.min(slipped,o.level):Math.max(slipped,o.level)):slipped,qty=o.close?Math.min(o.qty,this.position.qty):o.qty;
  const unitCost=this.cfg.fee+Math.round(price*this.cfg.multiplier*this.cfg.taxRate),cost=unitCost*qty;
  const prior=this.position,reduce=prior&&prior.side!==o.side?Math.min(qty,prior.qty):0,opening=qty-reduce;
  this.costs+=cost;o.status='filled';Object.assign(o,{fillIndex:this.i,fillRow:t[3],fillPrice:price,fillTime:t[0],cost,filledQty:qty,closeQty:reduce,openQty:opening});
  o.action=reduce?(opening?'平倉＋反手':reduce===prior.qty?'出場':'減碼'):prior?'加碼':'進場';
  this.event('成交',o,{price,qty,side:o.side,cost,forced,closeQty:reduce,openQty:opening,action:o.action,triggerRow:o.triggerRow??null});
  if(reduce){let left=reduce;const p=this.position;
   for(const lot of p.lots){if(!left)break;const take=Math.min(left,lot.qty);if(!take)continue;
    const entryCost=lot.cost*take/lot.qty,exitCost=unitCost*take,gross=(price-lot.price)*p.side*take*this.cfg.multiplier;
    this.realized+=gross;this.trades.push({side:p.side,qty:take,entry:lot.price,exit:price,entryOrder:lot.entryOrder,entryTriggerRow:lot.entryTriggerRow,entryTriggerTime:lot.entryTriggerTime,entryTriggerPrice:lot.entryTriggerPrice,entryLevel:lot.entryLevel,entryTime:lot.time,exitTime:t[0],entryRow:lot.row,exitRow:t[3],entryIndex:lot.index,exitIndex:this.i,triggerRow:o.triggerRow??null,triggerPrice:o.triggerPrice??null,triggerTime:o.triggerTime??null,level:o.level??null,reason:o.reason,cost:entryCost+exitCost,gross,net:gross-entryCost-exitCost,mae:lot.mae,mfe:lot.mfe,forced});
    lot.qty-=take;lot.cost-=entryCost;left-=take;
   }
   this.refreshPosition();if(!this.position)this.cancelExits(o);else this.position.lastFillIndex=this.i;
  }
  if(opening){
   const lot={side:o.side,qty:opening,price,index:this.i,time:t[0],row:t[3],cost:unitCost*opening,tp:o.tp,sl:o.sl,mae:0,mfe:0,reason:o.reason,entryOrder:o.id,entryTriggerRow:o.triggerRow??null,entryTriggerTime:o.triggerTime??null,entryTriggerPrice:o.triggerPrice??null,entryLevel:o.level??null};
   if(!this.position)this.position={...lot,positionId:o.id,lots:[],lastFillIndex:this.i};
   for(const other of this.orders)if(other!==o&&other.flatOnly&&['waiting','ready'].includes(other.status)){other.status='cancelled';this.event('已有部位取消觸價進場',other)}
   this.position.lots.push(lot);this.position.lastFillIndex=this.i;this.refreshPosition();if(this.cfg.auto)this.used[o.side]=true;
  }
  if(o.protectionId){const plan=this.protectionPlans.find(x=>x.id===o.protectionId);if(plan)plan.status='completed'}
  this.bindProtection();
 }
 setProtection({tp=0,sl=0,tpQty=1,slQty=1}={}){
  if(this.finished||!this.tick)throw Error('請先開始未結束的練習');
  if(![tp,sl].every(v=>Number.isInteger(v)&&v>=0)||(!tp&&!sl)||![tpQty,slQty].every(v=>Number.isInteger(v)&&v>=1&&v<=100))throw Error('請設定至少一項正整數點數，口數為1～100');
  this.cancelProtection();
  const plan={id:++this.seq,tp,sl,tpQty,slQty,status:'waiting-position',submitted:this.i};this.protection=plan;this.protectionPlans.push(plan);
  if(this.position){this.position.tp=0;this.position.sl=0}
  for(const o of this.orders)if(!o.close&&['waiting','ready'].includes(o.status)){o.tp=0;o.sl=0}
  this.event('啟動停利停損',null,{...plan});this.bindProtection();return plan;
 }
 setProtectionSide(key,{enabled,points=0,qty=1}={}){
  if(!['tp','sl'].includes(key)||typeof enabled!=='boolean')throw Error('停利停損項目無效');
  if(this.finished||!this.tick)throw Error('請先開始未結束的練習');
  if(enabled&&(!Number.isInteger(points)||points<1||!Number.isInteger(qty)||qty<1||qty>100))throw Error('點數請填正整數，口數為1～100');
  const live=this.protection&&['waiting-position','active','triggered'].includes(this.protection.status),plan=live?this.protection:null,label=key==='tp'?'停利':'停損';
  if(!plan){if(!enabled)return null;return this.setProtection({[key]:points,[key+'Qty']:qty})}
  if(plan.status==='triggered'&&enabled)throw Error('保護單已觸發待成交，請先取消後再開啟');
  if(plan.status==='triggered'&&plan.triggerReason===label){this.cancel(plan.orderId);plan.status=this.position?'active':'waiting-position';delete plan.triggerReason;delete plan.orderId}
  plan[key]=enabled?points:0;if(enabled)plan[key+'Qty']=qty;
  if(!plan.tp&&!plan.sl)this.cancelProtection();
  this.event((enabled?'開啟':'關閉')+label,null,{planId:plan.id,points:plan[key],qty:plan[key+'Qty']});return plan;
 }
 cancelProtection(status='cancelled'){
  const plan=this.protection;if(!plan||!['waiting-position','active','triggered'].includes(plan.status))return;
  for(const o of this.orders)if(o.protectionId===plan.id&&['waiting','ready'].includes(o.status))this.cancel(o.id);
  plan.status=status;this.event(status==='expired'?'停利停損到期':'取消停利停損',null,{planId:plan.id});
 }
 bindProtection(){const plan=this.protection,p=this.position;if(!plan)return;
  if(plan.status==='waiting-position'&&p){Object.assign(plan,{status:'active',anchor:p.price,side:p.side,positionId:p.positionId,boundIndex:this.i});p.tp=0;p.sl=0;this.event('停利停損綁定成交成本',null,{planId:plan.id,anchor:plan.anchor,side:plan.side})}
  else if(['active','triggered'].includes(plan.status)&&(!p||p.positionId!==plan.positionId))this.cancelProtection();
 }
 checkProtection(){const plan=this.protection,p=this.position;if(!plan||plan.status!=='active'||!p||this.i<=plan.boundIndex||this.i<=plan.submitted||this.i<=p.lastFillIndex||this.orders.some(o=>o.close&&['waiting','ready'].includes(o.status)))return;
  const delta=(this.tick[1]-plan.anchor)*plan.side;const reason=plan.sl>0&&delta<=-plan.sl?'停損':plan.tp>0&&delta>=plan.tp?'停利':null;if(!reason)return;
  const qty=Math.min(p.qty,reason==='停利'?plan.tpQty:plan.slQty),o=this.submit({close:true,qty,reason:'閃電'+reason});o.protectionId=plan.id;o.triggerRow=this.tick[3];o.triggerTime=this.tick[0];o.triggerPrice=this.tick[1];o.level=plan.anchor+plan.side*(reason==='停利'?plan.tp:-plan.sl);plan.status='triggered';plan.triggerReason=reason;plan.orderId=o.id;this.event('觸發',o,{planId:plan.id,price:this.tick[1],level:o.level});
 }
 step(){if(this.finished)return false;this.i++;const t=this.tick;if(!t){this.i--;return false}this.high=this.high===null?t[1]:Math.max(this.high,t[1]);this.low=this.low===null?t[1]:Math.min(this.low,t[1]);this.volume+=t[2];const minute=Math.floor(t[0]/60);let b=this.bars.at(-1);if(!b||b.minute!==minute){b={minute,open:t[1],high:t[1],low:t[1],close:t[1],volume:0};this.bars.push(b)}b.high=Math.max(b.high,t[1]);b.low=Math.min(b.low,t[1]);b.close=t[1];b.volume+=t[2];
  if(this.position){const pts=(t[1]-this.position.price)*this.position.side;this.position.mae=Math.min(this.position.mae,pts);this.position.mfe=Math.max(this.position.mfe,pts);for(const lot of this.position.lots){const move=(t[1]-lot.price)*this.position.side;lot.mae=Math.min(lot.mae,move);lot.mfe=Math.max(lot.mfe,move)}}
  // Prior ready orders fill first; newly filled positions cannot exit on this tick.
  for(const o of this.orders)if(o.status==='ready'&&this.i>o.ready)this.fill(o);
  for(const o of this.orders)if(o.status==='waiting'&&o.kind==='limit'&&this.i>o.submitted&&((o.side===1&&t[1]<=o.level)||(o.side===-1&&t[1]>=o.level))){o.triggerRow=t[3];o.triggerTime=t[0];o.triggerPrice=t[1];this.event('限價到價',o,{level:o.level,price:t[1]});this.fill(o)}
  for(const o of this.orders)if(o.status==='waiting'&&o.kind!=='limit'&&this.i>o.submitted&&((o.condition==='gte'&&t[1]>=o.level)||(o.condition==='lte'&&t[1]<=o.level))){o.status='ready';o.ready=this.i;o.triggerRow=t[3];o.triggerTime=t[0];o.triggerPrice=t[1];this.event('觸發',o,{level:o.level,price:t[1]})}
  this.checkProtection();
  const p=this.position;
  if(p&&this.i>p.lastFillIndex&&!this.orders.some(o=>o.close&&['waiting','ready'].includes(o.status))){const delta=(t[1]-p.price)*p.side;let reason=null;if(p.sl>0&&delta<=-p.sl)reason='停損';else if(p.tp>0&&delta>=p.tp)reason='停利';if(reason){const o=this.submit({close:true,qty:p.qty,reason});o.triggerRow=t[3];o.triggerPrice=t[1];o.triggerTime=t[0];o.level=p.price+p.side*(reason==='停利'?p.tp:-p.sl);this.event('觸發',o,{price:t[1],level:o.level})}}
  if(this.cfg.auto&&!this.position&&!this.orders.some(o=>['ready','waiting'].includes(o.status))){const open=this.data.ticks[0][1];const side=t[1]>=open+this.cfg.offset?1:t[1]<=open-this.cfg.offset?-1:0;if(side&&!this.used[side]){const o=this.submit({side,qty:this.cfg.qty,reason:'開盤±'+this.cfg.offset});o.level=open+side*this.cfg.offset;o.triggerRow=t[3];o.triggerPrice=t[1];o.triggerTime=t[0];this.event('觸發',o,{price:t[1],level:o.level})}}
  if(this.i===this.data.ticks.length-1){this.cancelProtection('expired');for(const o of this.orders)if(['ready','waiting'].includes(o.status)){o.status='expired';this.event('到期',o)}if(this.position){const o={id:++this.seq,side:-this.position.side,qty:this.position.qty,close:true,reason:'日盤結束（末筆成交模型）',status:'ready'};this.orders.push(o);this.fill(o,true)}this.finished=true;this.event('結束',null)}
  this.equity.push({index:this.i,time:t[0],value:this.cfg.capital+this.net});return true;
 }
 end(){if(this.finished||!this.tick)return false;this.cancelProtection();for(const o of this.orders)if(['waiting','ready'].includes(o.status))this.cancel(o.id);if(this.position){const o=this.submit({close:true,qty:this.position.qty,reason:'手動結束練習（當筆成交模型）'});this.fill(o,true)}this.event('手動結束練習');this.finished=true;this.equity.push({index:this.i,time:this.tick[0],value:this.cfg.capital+this.net});return true;}
 stats(){const a=this.trades,w=a.filter(t=>t.net>0),l=a.filter(t=>t.net<0),sum=x=>x.reduce((s,t)=>s+t.net,0);let peak=this.cfg.capital,mdd=0,peakTime=this.data.ticks[0]?.[0]??0,start=null,maxRecovery=0,streak=0,maxStreak=0;for(const e of this.equity){if(e.value>=peak){if(start!==null)maxRecovery=Math.max(maxRecovery,e.time-start);peak=e.value;peakTime=e.time;start=null}else{if(start===null)start=peakTime;mdd=Math.max(mdd,peak-e.value)}}for(const t of a){streak=t.net<0?streak+1:0;maxStreak=Math.max(maxStreak,streak)}return {count:a.length,net:this.net,winRate:a.length?w.length/a.length:null,pf:l.length?sum(w)/-sum(l):w.length?Infinity:null,expectancy:a.length?sum(a)/a.length:null,payoff:w.length&&l.length?(sum(w)/w.length)/(-sum(l)/l.length):null,mdd,maxStreak,recovery:start===null?maxRecovery:null};}
 snapshot(name,note=''){return {version:1,id:crypto.randomUUID(),createdAt:new Date().toISOString(),name,note,date:this.data.date,contract:this.data.contract,sha256:this.data.sha256,sourceFile:this.data.file,source:this.data.source,previousClose:this.data.previousClose,previousDate:this.data.previousDate,cfg:this.cfg,index:this.i,finished:this.finished,stats:this.stats(),trades:this.trades,events:this.events,orders:this.orders,equity:this.equity,position:this.position,protectionPlans:this.protectionPlans,net:this.net};}
}
