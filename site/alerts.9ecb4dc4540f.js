// This observer consumes only already-played ticks. It never places an order.
export class Alerts {
 constructor(config,previous=null){this.config={...config};this.previous=previous;this.fired=new Set();this.open=null;this.last=null;this.high=null;this.low=null;this.hasOpen=false;this.rangeSeen=false;this.rangeReady=false;this.dayHigh=null;this.dayLow=null;this.extents={};this.updates=[]}
 step(t,notify=true){const [sec,price]=t,c=this.config,out=[];this.updates=[];
  if(this.open===null){this.open=price;this.hasOpen=Math.floor(sec/60)===525}
  const emit=(key,condition,message)=>{if(notify&&c[key]&&!this.fired.has(key)&&condition){this.fired.add(key);if(key==='yesterdayUp'||key==='yesterdayDown'){this.extents[key]={time:sec,extreme:price,level:key==='yesterdayUp'?this.previous.high:this.previous.low};message=this.extensionMessage(key)}out.push({key,time:sec,price,message})}};
  this.dayHigh=this.dayHigh===null?price:Math.max(this.dayHigh,price);this.dayLow=this.dayLow===null?price:Math.min(this.dayLow,price);
  emit('amplitude',this.dayHigh-this.dayLow>=c.amplitudePoints,`目前震幅 ${this.dayHigh-this.dayLow} 點，已達設定 ${c.amplitudePoints} 點（高 ${this.dayHigh} ／ 低 ${this.dayLow}）`);
  if(this.hasOpen){emit('openUp',price>=this.open+c.upPoints,`現價 ${price}，達開盤價＋${c.upPoints}點`);emit('openDown',price<=this.open-c.downPoints,`現價 ${price}，達開盤價－${c.downPoints}點`)}
  if(sec<=c.cutoff){this.high=this.high===null?price:Math.max(this.high,price);this.low=this.low===null?price:Math.min(this.low,price);this.rangeSeen=true}
  else if(this.hasOpen&&this.rangeSeen){this.rangeReady=true;emit('rangeUp',price>=this.high,`現價 ${price}，觸及／突破上午區間高點 ${this.high}`);emit('rangeDown',price<=this.low,`現價 ${price}，觸及／跌破上午區間低點 ${this.low}`)}
  const p=this.previous;if(this.hasOpen&&p&&this.open>=p.low&&this.open<=p.high){emit('yesterdayUp',price>=p.high,`現價 ${price}，觸及／突破昨日高點 ${p.high}`);emit('yesterdayDown',price<=p.low,`現價 ${price}，觸及／跌破昨日低點 ${p.low}`)}
  for(const [key,extent] of Object.entries(this.extents)){
   const extreme=key==='yesterdayUp'?Math.max(extent.extreme,price):Math.min(extent.extreme,price);
   if(extreme!==extent.extreme){extent.extreme=extreme;this.updates.push({key,time:extent.time,message:this.extensionMessage(key)})}
  }
  this.last=price;return out;
 }
 extensionMessage(key){const e=this.extents[key],up=key==='yesterdayUp',format=v=>Number(v).toLocaleString('zh-TW',{maximumFractionDigits:2});return `已${up?'突破昨高':'跌破昨低'}${format(e.level)}，已${up?'上行':'下行'}${format(Math.max(0,up?e.extreme-e.level:e.level-e.extreme))}點`}
}
