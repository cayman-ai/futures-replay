export function movingAverage(bars,period){if(!Number.isInteger(period)||period<1||period>300)throw Error('均線週期需為1～300的整數');let sum=0;return bars.map((b,i)=>{sum+=b.close;if(i>=period)sum-=bars[i-period].close;return i+1>=period?sum/period:null})}
export function chartWindow(count,span=null,offset=0){if(!count)return {start:0,end:0};const end=Math.max(1,count-Math.max(0,Math.min(count-1,Math.trunc(offset))));const start=span==null?0:Math.max(0,end-Math.max(1,Math.trunc(span)));return {start,end}}

export function candleLayout(width,count,span=null){const slots=span==null?Math.max(1,Math.ceil(width/12),count):Math.max(8,span);return {slots,step:width/slots}}
