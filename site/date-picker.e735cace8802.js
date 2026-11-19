// Avoid OS dropdown popups: only this bounded list scrolls, with explicit navigation.
export class DatePicker {
 constructor(select){
  this.select=select;this.label=select.closest('label');this.label.hidden=true;
  this.root=document.createElement('section');this.root.className='datePicker';this.root.innerHTML='<div class="datePickerHead"><span>交易日期</span><span id="availableDates"></span></div><div class="datePickerNav"><button type="button" data-shift="-1">↑ 較新</button><button type="button" data-latest>回到最新</button><button type="button" data-shift="1">↓ 較舊</button></div><div id="dateOptions" class="dateOptions" role="listbox" aria-label="指定交易日期" tabindex="0"></div><p class="datePickerHint">可用滑鼠或觸控板上下捲動；指定日期模式下可點選，或按方向鍵、Home／End。</p>';
  this.label.after(this.root);this.list=this.root.querySelector('#dateOptions');this.list.addEventListener('click',e=>{const b=e.target.closest('[data-date]');if(b&&!this.select.disabled)this.choose(b.dataset.date)});
  this.root.querySelectorAll('[data-shift]').forEach(b=>b.onclick=()=>this.shift(Number(b.dataset.shift)));
  this.root.querySelector('[data-latest]').onclick=()=>{this.choose(this.select.options[0]?.value);this.list.scrollTop=0};
  this.list.addEventListener('keydown',e=>{if(this.select.disabled)return;let next=this.select.selectedIndex;switch(e.key){case 'ArrowUp':next--;break;case 'ArrowDown':next++;break;case 'Home':next=0;break;case 'End':next=this.select.options.length-1;break;case 'PageUp':next-=7;break;case 'PageDown':next+=7;break;default:return}e.preventDefault();this.choose(this.select.options[Math.max(0,Math.min(this.select.options.length-1,next))]?.value)});
  this.select.addEventListener('change',()=>this.sync());this.sync();
 }
 choose(value){if(this.select.disabled||!value)return;this.select.value=value;this.select.dispatchEvent(new Event('change',{bubbles:true}));this.sync();this.reveal();this.list.focus({preventScroll:true})}
 shift(step){const i=Math.max(0,Math.min(this.select.options.length-1,this.select.selectedIndex+step));this.choose(this.select.options[i]?.value)}
 sync(){const options=[...this.select.options],key=options.map(o=>o.value).join(',');if(key!==this.key){this.key=key;this.list.replaceChildren();for(const option of options){const b=document.createElement('button');b.type='button';b.id='dateOption'+option.value;b.dataset.date=option.value;b.setAttribute('role','option');b.tabIndex=-1;const v=option.value;b.textContent=v.slice(0,4)+'/'+v.slice(4,6)+'/'+v.slice(6,8);this.list.append(b)}}
  this.list.setAttribute('aria-disabled',String(this.select.disabled));for(const b of this.list.children){b.setAttribute('aria-selected',String(b.dataset.date===this.select.value));b.disabled=this.select.disabled}
  if(this.select.value)this.list.setAttribute('aria-activedescendant','dateOption'+this.select.value);
  const latest=options[0]?.value;this.root.querySelector('#availableDates').textContent=latest?`${options.length}日 · 最新 ${latest.slice(0,4)}/${latest.slice(4,6)}/${latest.slice(6,8)}`:'正在載入日期';
  const i=this.select.selectedIndex,n=options.length,disabled=this.select.disabled||!n;this.root.querySelector('[data-latest]').disabled=!n;this.root.querySelector('[data-shift="-1"]').disabled=disabled||i<=0;this.root.querySelector('[data-shift="1"]').disabled=disabled||i>=n-1;
 }
 reveal(){const b=[...this.list.children].find(x=>x.dataset.date===this.select.value);if(!b)return;const top=b.offsetTop,bottom=top+b.offsetHeight;if(top<this.list.scrollTop)this.list.scrollTop=top;else if(bottom>this.list.scrollTop+this.list.clientHeight)this.list.scrollTop=bottom-this.list.clientHeight}
}
