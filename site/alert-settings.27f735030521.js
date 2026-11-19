export const ALERT_DEFAULTS=Object.freeze({openUp:false,openDown:false,upPoints:30,downPoints:30,rangeUp:false,rangeDown:false,cutoff:34259,yesterdayUp:false,yesterdayDown:false,amplitude:false,amplitudePoints:300});
export function normalizeAlerts(value){const c={...ALERT_DEFAULTS,...value};for(const k of ['openUp','openDown','rangeUp','rangeDown','yesterdayUp','yesterdayDown','amplitude'])if(typeof c[k]!=='boolean')throw Error('警示勾選設定無效');for(const k of ['upPoints','downPoints','amplitudePoints'])if(!Number.isSafeInteger(c[k])||c[k]<1)throw Error('警示點數請填入正整數');if(!Number.isInteger(c.cutoff)||c.cutoff<31559||c.cutoff>=43200||c.cutoff%60!==59)throw Error('區間時間請設在08:45～11:59');return Object.fromEntries(Object.keys(ALERT_DEFAULTS).map(k=>[k,c[k]]))}
export class AlertRotation {
 constructor(){this.clear()}
 clear(){this.items=[];this.keys=new Set();this.index=0}
 add(key,text){if(this.keys.has(key))return false;this.keys.add(key);this.items.push(text);return true}
 update(key,text){const i=[...this.keys].indexOf(key);if(i<0||this.items[i]===text)return false;this.items[i]=text;return true}
 next(){if(this.items.length)this.index=(this.index+1)%this.items.length;return this.current}
 get current(){return this.items[this.index]??''}
}
export class AlertTicker {
 constructor(root){this.root=root;this.rotation=new AlertRotation();root.hidden=true;root.innerHTML='<div class="alertTickerHead"><span>警示通知 · 拖曳移動</span><span class="alertTickerCount"></span><button aria-label="關閉警示視窗">×</button></div><div class="alertTickerBody" role="status" aria-live="polite"></div>';this.body=root.querySelector('.alertTickerBody');this.count=root.querySelector('.alertTickerCount');root.querySelector('button').onclick=()=>{root.hidden=true;this.stop()};const head=root.querySelector('.alertTickerHead');head.onpointerdown=e=>{if(e.target.closest('button'))return;e.preventDefault();const rect=root.getBoundingClientRect();this.drag={x:e.clientX,y:e.clientY,left:rect.left,top:rect.top};head.setPointerCapture(e.pointerId)};head.onpointermove=e=>{if(!this.drag)return;this.place(this.drag.left+e.clientX-this.drag.x,this.drag.top+e.clientY-this.drag.y)};head.onpointerup=head.onpointercancel=()=>{this.drag=null};window.addEventListener('resize',()=>{if(!root.hidden){const b=root.getBoundingClientRect();this.place(b.left,b.top)}})}
 place(x,y){const b=this.root.getBoundingClientRect();this.root.style.left=Math.max(0,Math.min(x,window.innerWidth-b.width))+'px';this.root.style.top=Math.max(0,Math.min(y,window.innerHeight-b.height))+'px';this.root.style.right='auto'}
 render(){this.body.textContent=this.rotation.current;this.count.textContent=`${this.rotation.index+1} / ${this.rotation.items.length}`;this.body.classList.remove('tickerEnter');void this.body.offsetWidth;this.body.classList.add('tickerEnter')}
 stop(){clearInterval(this.timer);this.timer=null}
 add(key,text){if(!this.rotation.add(key,text))return;if(this.root.hidden){this.root.hidden=false;this.rotation.index=this.rotation.items.length-1;this.render()}else this.count.textContent=`${this.rotation.index+1} / ${this.rotation.items.length}`;if(!this.timer)this.timer=setInterval(()=>{if(this.rotation.items.length>1){this.rotation.next();this.render()}},5000)}
 update(key,text){const before=this.rotation.current;if(this.rotation.update(key,text)&&before!==this.rotation.current)this.body.textContent=this.rotation.current}
 clear(){this.stop();this.rotation.clear();this.root.hidden=true;this.body.textContent=''}
}
