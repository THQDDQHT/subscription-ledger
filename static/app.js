'use strict';
const $ = s => document.querySelector(s);
const labels = {active:'使用中',cancelling:'准备取消',cancelled:'已取消续费',ended:'已结束'};
const WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'];
let csrf='', items=[], stats={}, viewKey='recent', filterKey='all', focusKey='', keyword='', sortKey='date';
const collapsedGroups=new Set(['recent:month','all:cancelled','all:ended']);
let reportTimer, selectedId='', displayedDetailId='', pendingBackup=null;

function text(tag, value, cls) { const e=document.createElement(tag); e.textContent=value; if(cls)e.className=cls; return e; }
function icon(id) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('aria-hidden','true');
  const use=document.createElementNS('http://www.w3.org/2000/svg','use');
  use.setAttribute('href','#i-'+id);
  svg.append(use);
  return svg;
}
/* 金额与日期的展示口径：金额千分位、日期保留 ISO 记录并补中文读法。 */
function money(value) { const [whole,fraction]=String(value).split('.'); return '¥'+whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:''); }
function moneyCents(cents) { return money((cents/100).toFixed(2)); }
// 渲染用：货币符号单独成元素以便弱化，数字保持等宽；纯文本场景仍用 money()。
function moneyNode(value) { const f=document.createDocumentFragment(); f.append(text('span','¥','cur'),document.createTextNode(money(value).slice(1))); return f; }
function parseDay(iso) { return Date.parse(iso+'T00:00:00Z'); }
function daysUntil(dateStr) { return (parseDay(dateStr)-parseDay(stats.today))/86400000; }
function friendlyDate(iso) {
  if(!iso) return '';
  const time=parseDay(iso); if(Number.isNaN(time)) return iso;
  const d=new Date(time); const year=d.getUTCFullYear();
  const sameYear=!stats.today||stats.today.slice(0,4)===String(year);
  return `${sameYear?'':year+'年'}${d.getUTCMonth()+1}月${d.getUTCDate()}日 ${WEEKDAYS[d.getUTCDay()]}`;
}
function relativeDay(iso) {
  if(!stats.today) return {text:'',cls:''};
  const days=daysUntil(iso);
  if(days<0) return {text:`逾期 ${-days} 天`,cls:'overdue'};
  if(days===0) return {text:'今天',cls:'soon'};
  if(days===1) return {text:'明天',cls:'soon'};
  return {text:`还剩 ${days} 天`,cls:days<7?'soon':''};
}
function dateNode(iso) { const t=text('time',friendlyDate(iso)); t.dateTime=iso; t.title=iso; return t; }
async function api(url, method='GET', body) {
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok){
    if(response.status===401 && url!=='/api/login'){
      csrf='';items=[];stats={};focusKey='';filterKey='all';viewKey='recent';keyword='';sortKey='date';collapsedGroups.clear();
      selectedId='';displayedDetailId='';history.replaceState(null,'',location.pathname+location.search);
      $('#search').value='';$('#sort').value='date';$('#filter').value='all';
      $('#ledger').hidden=true; $('#login-panel').hidden=false; $('#logout').hidden=true; $('#logout-mobile').hidden=true;
      for(const s of ['#items','#detail-body','#detail-actions'])$(s).replaceChildren();
      for(const s of ['#budget','#forecast','#window-note','#renew-name','#renew-diff','#message','#edit-error','#renew-error','#restore-status','#detail-title','#result-count','#recent-count','#all-count','#plan-preview','#overdue-count','#confirm-title','#confirm-body','#confirm-note','#export-count','#export-name','#import-summary'])$(s).textContent='';
      $('#message').className='';
      for(const s of ['#editor','#renew-dialog','#detail','#confirm-dialog'])if($(s).open)$(s).close();
      $('#item-form').reset();$('#renew-form').reset();$('#import-file').value='';$('#restore').disabled=true;$('#import-summary').hidden=true;pendingBackup=null;
      try{csrf=(await api('/api/session')).csrf;}catch(e){/* Login retries session discovery; private DOM stays cleared. */}
    }
    throw new Error(data.error||`请求失败 ${response.status}`);
  }
  return data;
}
/* 写入回执：成功与失败必须可区分，且不把用户的位置弄丢。 */
function report(message, ok) { clearTimeout(reportTimer); const e=$('#message'); e.textContent=message; e.className=ok?'ok':''; if(ok)reportTimer=setTimeout(clearReport,6000); }
function reportOk(message) { report(message, true); }
function reportError(error) { const message=error.message||error; report(message,false); if($('#detail').open){let e=$('#detail-error');if(!e){e=text('p','','error');e.id='detail-error';e.setAttribute('role','alert');$('#detail-body').prepend(e);}e.textContent=message;} }
function clearReport() { const e=$('#message'); e.textContent=''; e.className=''; }
function localReport(target, message, ok) { const e=$(target); e.textContent=message; e.className=ok?'':'error'; }
/* 页面内确认：与其他弹窗同一套样式；关闭即视为取消。 */
function confirmDialog({title, body, note='', accept='确定', danger=true}) {
  return new Promise(resolve=>{
    const d=$('#confirm-dialog'), ok=$('#confirm-accept');
    $('#confirm-title').textContent=title;$('#confirm-body').textContent=body;$('#confirm-note').textContent=note;
    ok.textContent=accept;ok.className=danger?'danger':'';
    const done=value=>{ok.removeEventListener('click',yes);d.removeEventListener('close',no);if(d.open)d.close();resolve(value);};
    const yes=()=>done(true), no=()=>done(false);
    ok.addEventListener('click',yes);d.addEventListener('close',no);
    d.showModal();ok.focus();
  });
}

function action(label, fn, cls, iconId, key) {
  const b=text('button',label,cls); b.type='button';
  if(iconId) b.prepend(icon(iconId));
  if(key) b.dataset.key=key;
  b.addEventListener('click',()=>Promise.resolve().then(fn).catch(reportError));
  return b;
}
function cycleLabel(r) { return r.cycle==='monthly'?'月付':r.cycle==='quarterly'?'季付':r.cycle==='yearly'?'年付':`每 ${r.days} 天`; }
function emptyState(title, desc, control) {
  const box=text('div','','empty');
  box.append(text('b',title));
  if(desc) box.append(text('span',desc));
  if(control) box.append(control);
  return box;
}
// 首次加载超过 120ms 才显示骨架，避免本地秒开时闪一下。
function bone(cls) { return text('span','','bone '+cls); }
function skeletonRows(count=6) {
  const frag=document.createDocumentFragment();
  for(let i=0;i<count;i++){
    const row=text('div','','subscription skeleton');row.setAttribute('aria-hidden','true');
    const title=text('div','','row-title');const name=text('div','','row-name');name.append(bone('bone--w60'),bone('bone--w40'));title.append(bone('bone--avatar'),name);
    const amount=text('div','','row-amount');amount.append(bone('bone--w60'),bone('bone--w40'));
    const date=text('div','','row-date');date.append(bone('bone--w60'),bone('bone--w80'));
    const status=text('div','','row-status');status.append(bone('bone--chip'));
    row.append(title,amount,date,status,text('div','','row-actions'));frag.append(row);
  }
  return frag;
}
function setLoading(on) {
  $('#overview').classList.toggle('is-loading',on);
  if(on){$('#list-scroll').setAttribute('aria-busy','true');$('#items').replaceChildren(skeletonRows());$('#result-count').textContent='正在加载…';}
  else $('#list-scroll').removeAttribute('aria-busy');
}
// 近期按订阅的当前计划分组；预测事件只用于统计，不生成重复操作。
function isActive(r) {return ['active','cancelling'].includes(r.status);}
function recentGroup(r) {
  if(!isActive(r))return null;
  const days=daysUntil(r.next_date);
  return days<0?'overdue':days<7?'week':days<30?'month':null;
}
function selectGroups() {
  const query=keyword.trim().toLocaleLowerCase();
  const selected=items.filter(r=>(viewKey!=='recent'||recentGroup(r)!==null) && (filterKey==='all'||r.status===filterKey)
    && (!query || (r.name+' '+r.notes).toLocaleLowerCase().includes(query)));
  selected.sort((a,b)=>(sortKey==='name'?a.name.localeCompare(b.name,'zh-CN'):sortKey==='amount'?b.amount_cents-a.amount_cents:a.next_date.localeCompare(b.next_date)) || a.name.localeCompare(b.name,'zh-CN'));
  const definitions=viewKey==='recent'?[['overdue','逾期未确认'],['week','未来 7 天'],['month','之后至 30 天']]:Object.entries(labels);
  return definitions.map(([key,title])=>({key:viewKey+':'+key,title,rows:selected.filter(r=>(viewKey==='recent'?recentGroup(r):r.status)===key)})).filter(g=>g.rows.length);
}
function subscriptionRow(r) {
  const row=text('article','','subscription'+(r.id===selectedId?' selected':''));
  const active=isActive(r);
  const title=action('',()=>showDetail(r),'row-title',null,`${r.id}:detail`);
  const avatar=text('span',Array.from(r.name)[0]||'订','avatar avatar--'+r.status);avatar.setAttribute('aria-hidden','true');
  const name=text('span','','row-name');name.append(text('span',r.name,'service-name'),text('small',r.auto_renew?'自动续费已开':'手动续费','row-subline'));
  title.append(avatar,name);title.setAttribute('aria-label',`查看 ${r.name} 的详情`);
  const amount=text('div','','row-amount');const price=text('strong','');price.append(moneyNode(r.amount));amount.append(price,text('small',cycleLabel(r)));
  const date=text('div','','row-date');
  if(active){const rel=relativeDay(r.next_date);if(rel.cls)date.classList.add(rel.cls);date.append(text('strong',rel.text),dateNode(r.next_date));}
  else{date.classList.add('idle');date.append(text('strong',r.end_date?'服务截止':'不再计入预算'));date.append(r.end_date?dateNode(r.end_date):text('small','—'));}
  const status=text('div','','row-status');status.append(text('span',labels[r.status],`chip chip--${r.status}`));
  const controls=text('div','','row-actions');
  if(viewKey==='recent'&&['overdue','week'].includes(recentGroup(r))){
    const b=action('记录续费',()=>renew(r),'ghost compact','renew',`${r.id}:renew`);b.setAttribute('aria-label',`记录 ${r.name} 的续费`);controls.append(b);
  } else { const chevron=icon('chevron');chevron.classList.add('row-chevron');controls.append(chevron); }
  row.append(title,amount,date,status,controls);
  // 整行可点：按钮与链接保留各自动作，选中文字时不触发。
  row.addEventListener('click',e=>{if(e.target.closest('button,a')||String(getSelection()))return;showDetail(r);});
  return row;
}
function renderItems() {
  const area=$('#items');area.replaceChildren();
  const groups=selectGroups();const total=groups.reduce((n,g)=>n+g.rows.length,0);
  $('#result-count').textContent=`${keyword.trim()?'找到':'共'} ${total} 项订阅`;
  $('#clear-search').hidden=!keyword;
  if(!total){
    let control=null;
    if(!keyword.trim()){
      if(!items.length)control=action('新增订阅',()=>edit(null),'','plus');
      else if(viewKey==='recent'){control=text('a','查看全部订阅');control.href='#all';}
    }
    area.append(emptyState(items.length?'这里暂时没有订阅':'从第一份订阅开始',keyword.trim()?'试试其他名称或备注关键词。':viewKey==='recent'?'当前没有 30 天内待处理的计划。':'点击新增订阅，记录费用与下次续费日期。',control));
  }
  for(const group of groups){
    const kind=group.key.split(':')[1];
    const section=text('details','','subscription-group'+(kind==='overdue'?' group--overdue':kind==='week'?' group--soon':''));section.open=keyword.trim()?true:!collapsedGroups.has(group.key);
    const heading=text('summary','','group-heading');
    const lead=text('span','','group-lead');lead.append(text('span',group.title,'group-title'),text('span',`${group.rows.length} 项`,'count'));heading.append(lead);
    if(viewKey==='recent'||['active','cancelling'].includes(kind)){const sum=text('span','','group-sum');sum.append(moneyNode((group.rows.reduce((n,r)=>n+r.amount_cents,0)/100).toFixed(2)));heading.append(sum);}
    section.append(heading);
    section.addEventListener('toggle',()=>{if(!section.isConnected)return;if(section.open){section.classList.add('just-opened');setTimeout(()=>section.classList.remove('just-opened'),300);}if(keyword.trim())return;if(section.open)collapsedGroups.delete(group.key);else collapsedGroups.add(group.key);});
    for(const r of group.rows)section.append(subscriptionRow(r));area.append(section);
  }
  restoreListFocus();
}
function restoreListFocus() {
  if(!focusKey)return;
  const want=focusKey;focusKey='';const id=want.split(':')[0];
  // 桌面详情更新后仍能在操作区继续；窄屏焦点留在模态弹窗内。
  if($('#detail').open){$('#close-detail').focus({preventScroll:true});return;}
  const target=[...$('#items').querySelectorAll('[data-key]')].find(b=>b.dataset.key===want)||[...$('#items').querySelectorAll('[data-key]')].find(b=>b.dataset.key===id+':detail');
  if(target&&target.closest('details').open)target.focus({preventScroll:true});
  else [...document.querySelectorAll('[data-view]')].find(b=>b.dataset.view===viewKey&&b.getClientRects().length)?.focus({preventScroll:true});
}
function parseRoute(hash) {
  const [view,query]=(hash.replace(/^#/, '')||'recent').split('?');
  return {view:['recent','all','backup'].includes(view)?view:'recent',id:view==='backup'?'':new URLSearchParams(query).get('item')||''};
}
function routeURL(view,id='') {return '#'+view+(id?'?item='+encodeURIComponent(id):'');}
function readRoute() {
  if($('#ledger').hidden)return;
  const route=parseRoute(location.hash);
  if(route.view!==viewKey){keyword='';filterKey='all';$('#search').value='';$('#filter').value='all';$('#list-scroll').scrollTop=0;}
  viewKey=route.view;selectedId=route.id;
  renderViews();
}
function showDetail(r) {location.hash=routeURL(viewKey,r.id);}
function closeDetail() {
  focusKey=selectedId+':detail';selectedId='';
  history.replaceState(null,'',routeURL(viewKey));
  if($('#detail').open)$('#detail').close();
  renderViews();
}
function renderViews() {
  const scroll=$('#list-scroll').scrollTop;
  const titles={recent:['近期处理','先处理到期事项，再整理订阅'],all:['全部订阅','查找、比较与管理全部订阅'],backup:['数据备份','备份你的账本，按需恢复']};
  $('#page-title').textContent=titles[viewKey][0];$('#page-desc').textContent=titles[viewKey][1];
  for(const b of document.querySelectorAll('[data-view]')){if(b.dataset.view===viewKey)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
  $('#overview').hidden=viewKey!=='recent';$('#board').hidden=viewKey==='backup';$('#backup-page').hidden=viewKey!=='backup';$('#add').hidden=viewKey==='backup';
  $('#recent-count').textContent=String(items.filter(r=>recentGroup(r)!==null).length);$('#all-count').textContent=String(items.length);
  renderDetail();renderItems();$('#list-scroll').scrollTop=scroll;
}
async function load() {
  const first=!items.length;
  const pending=first?setTimeout(()=>setLoading(true),120):0;
  let result;
  try{result=await Promise.all([api('/api/items'),api('/api/summary')]);}
  catch(e){
    clearTimeout(pending);setLoading(false);
    if(first&&!$('#ledger').hidden){$('#items').replaceChildren(emptyState('无法加载账本',e.message||String(e),action('重试',load,'ghost')));$('#result-count').textContent='';}
    throw e;
  }
  clearTimeout(pending);setLoading(false);
  [items,stats]=result;
  $('#budget').replaceChildren(moneyNode(stats.monthly_budget));$('#forecast').replaceChildren(moneyNode(stats.forecast_30));
  const overdue=items.filter(r=>isActive(r)&&daysUntil(r.next_date)<0).length;
  $('#overdue-count').textContent=`${overdue} 项`;$('#overdue-count').classList.toggle('is-zero',overdue===0);
  $('#window-note').textContent=`今天 ${stats.today} · ${friendlyDate(stats.today)} · 中国标准时间`;
  renderExportFacts();
  const route=parseRoute(location.hash);viewKey=route.view;selectedId=route.id;
  renderViews();
}
function syncDetailMode() {
  const d=$('#detail');if(!selectedId||$('#ledger').hidden||$('#editor').open||$('#renew-dialog').open||$('#confirm-dialog').open)return;
  const modal=window.matchMedia('(max-width:1279px)').matches;
  if(d.open&&d.dataset.modal===String(modal))return;
  if(d.open)d.close();
  d.dataset.modal=String(modal);
  if(modal)d.showModal();else d.show();
}
function renderDetail() {
  const r=items.find(item=>item.id===selectedId);const d=$('#detail');
  $('#board').classList.toggle('has-detail',!!r);
  if(!r){if(d.open)d.close();if(selectedId){selectedId='';history.replaceState(null,'',routeURL(viewKey));}displayedDetailId='';$('#detail-body').replaceChildren();$('#detail-actions').replaceChildren();return;}
  const body=$('#detail-body'),scroll=displayedDetailId===r.id?body.scrollTop:0;displayedDetailId=r.id;$('#detail-title').textContent=r.name;body.replaceChildren();
  const price=text('p','','detail-amount');price.append(moneyNode(r.amount));
  body.append(text('span',labels[r.status],`chip chip--${r.status}`),price,text('p',cycleLabel(r),'muted'));
  const plan=text('div','','detail-plan');
  if(isActive(r)){const rel=relativeDay(r.next_date);if(rel.cls)plan.classList.add(rel.cls);plan.append(text('span','当前待确认计划'),text('strong',rel.text),text('span',`${r.next_date} · ${friendlyDate(r.next_date)}`,'detail-plan-date'));}
  else plan.append(text('span','原计划日期'),text('strong',r.next_date),text('span',friendlyDate(r.next_date),'detail-plan-date'));
  body.append(plan);
  const list=text('dl','','detail-facts');
  for(const [label,value] of [['续费方式',r.auto_renew?'自动续费已开':'手动续费'],['计入预算',isActive(r)?'是':'否'],['服务可用截止日',r.end_date?`${r.end_date} · ${friendlyDate(r.end_date)}`:'未填写']])list.append(text('dt',label),text('dd',value));body.append(list);
  if(r.url){const a=text('a','前往管理订阅','detail-link');a.href=r.url;a.target='_blank';a.rel='noopener noreferrer';a.append(icon('external'));body.append(a);}
  body.append(text('h3','备注'),text('p',r.notes||'暂无备注','detail-notes'));
  const remove=action('删除订阅',async()=>{
    const ok=await confirmDialog({title:`删除「${r.name}」？`,body:'这条订阅及其全部续费历史将被删除，无法撤销。',note:'如果只是停用，可改为「已取消续费」或「已结束」保留记录。',accept:'删除订阅'});
    if(!ok)return;
    remove.disabled=true;try{await api(`/api/items/${r.id}`,'DELETE',{confirm:true});closeDetail();await load();reportOk(`已删除「${r.name}」`);}finally{remove.disabled=false;}
  },'quiet danger-text','trash');
  body.append(remove);
  const controls=$('#detail-actions');controls.replaceChildren();controls.append(action('编辑订阅',()=>edit(r),'ghost','edit'));
  if(isActive(r))controls.append(action('记录续费',()=>renew(r),'','renew'));
  syncDetailMode();body.scrollTop=scroll;
}
function updatePlanPreview() {
  const f=$('#item-form').elements;
  $('#plan-preview').textContent=f.amount.value&&f.next_date.value?`${cycleLabel({cycle:f.cycle.value,days:f.days.value||'…'})} · 每期 ${money(f.amount.value)} · 下次 ${f.next_date.value}（${friendlyDate(f.next_date.value)}）`:'填写费用与日期，建立你的续费计划。';
}
function cycleField() {const f=$('#item-form');const show=f.elements.cycle.value==='days';$('#days-field').hidden=!show;f.elements.days.required=show;}
function edit(r) {const f=$('#item-form');f.reset();$('#edit-error').textContent='';$('#editor-title').textContent=r?'编辑订阅':'新增订阅';f.elements.id.value=r?.id||''; if(r){for(const key of ['name','amount','cycle','days','next_date','status','end_date','url','notes'])f.elements[key].value=r[key]??'';f.elements.auto_renew.checked=r.auto_renew;}else{f.elements.next_date.value=stats.today;}cycleField();$('#extra-fields').open=Boolean(r&&(r.notes||r.url||r.end_date));updatePlanPreview();$('#editor').showModal();}
function renew(r) {
  const f=$('#renew-form');f.reset();f.elements.id.value=r.id;
  f.elements.actual_date.value=stats.today;f.elements.actual_date.max=stats.today;
  f.elements.next_date.value=r.suggested_next;
  $('#renew-name').textContent=r.name;
  // 显示被替换的原值，避免用户必须记住背后卡片上的日期
  $('#renew-diff').textContent=`当前计划日期 ${r.next_date}（${friendlyDate(r.next_date)}）· 每期 ${money(r.amount)}（${cycleLabel(r)}）`;
  $('#renew-error').textContent='';
  $('#renew-dialog').showModal();
}
async function submitGuard(form, fn, target) {const b=form.querySelector('button[type="submit"]');const original=b.textContent;b.disabled=true;b.textContent='保存中…';target.textContent='';try{await fn();}catch(e){target.textContent=e.message;}finally{b.disabled=false;b.textContent=original;}}
$('#login-form').addEventListener('submit',e=>{e.preventDefault();submitGuard(e.target,async()=>{csrf=(await api('/api/session')).csrf;const result=await api('/api/login','POST',{password:e.target.elements.password.value});csrf=result.csrf;e.target.reset();$('#login-panel').hidden=true;$('#ledger').hidden=false;$('#logout').hidden=false;$('#logout-mobile').hidden=false;await load();},$('#message'));});
$('#item-form').addEventListener('submit',e=>{e.preventDefault();submitGuard(e.target,async()=>{const f=e.target.elements;const r={};for(const key of ['name','amount','cycle','next_date','status','url','notes'])r[key]=f[key].value;r.days=r.cycle==='days'?Number(f.days.value):null;r.end_date=f.end_date.value||null;r.auto_renew=f.auto_renew.checked;const editing=f.id.value;clearReport();await api(editing?`/api/items/${editing}`:'/api/items',editing?'PUT':'POST',r);$('#editor').close();focusKey=editing?`${editing}:detail`:'';try{await load();}catch(error){reportError('已保存，但列表刷新失败：'+error.message);return;}reportOk(editing?`已保存「${r.name}」`:`已新增「${r.name}」`);},$('#edit-error'));});
$('#renew-form').addEventListener('submit',e=>{e.preventDefault();submitGuard(e.target,async()=>{const f=e.target.elements;const r=items.find(x=>x.id===f.id.value);clearReport();await api(`/api/items/${f.id.value}/renew`,'POST',{actual_date:f.actual_date.value,next_date:f.next_date.value,confirm:f.confirm.checked});$('#renew-dialog').close();focusKey=`${f.id.value}:renew`;try{await load();}catch(error){reportError('已记录续费，但列表刷新失败：'+error.message);return;}reportOk(`已续费「${r?r.name:'订阅'}」· 下次 ${f.next_date.value}（${friendlyDate(f.next_date.value)}）`);},$('#renew-error'));});
$('#item-form').elements.cycle.addEventListener('change',cycleField);
$('#add').addEventListener('click',()=>edit(null));
for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>$('#'+b.dataset.close).close());
window.addEventListener('hashchange',readRoute);
window.matchMedia('(max-width:1279px)').addEventListener('change',syncDetailMode);
$('#close-detail').addEventListener('click',closeDetail);
for(const id of ['#editor','#renew-dialog','#confirm-dialog'])$(id).addEventListener('close',syncDetailMode);
$('#detail').addEventListener('cancel',e=>{e.preventDefault();closeDetail();});
$('#collapse-nav').addEventListener('click',()=>{const collapsed=$('#ledger').classList.toggle('nav-collapsed');$('#collapse-nav').setAttribute('aria-expanded',String(!collapsed));$('#collapse-nav').setAttribute('aria-label',collapsed?'展开导航':'收起导航');});
$('#filter').addEventListener('change',e=>{filterKey=e.target.value;$('#list-scroll').scrollTop=0;renderItems();});
$('#search').addEventListener('input',e=>{keyword=e.target.value;$('#list-scroll').scrollTop=0;renderItems();});
$('#clear-search').addEventListener('click',()=>{keyword='';$('#search').value='';renderItems();$('#search').focus();});
$('#sort').addEventListener('change',e=>{sortKey=e.target.value;renderItems();});
$('#item-form').addEventListener('input',updatePlanPreview);
$('#item-form').addEventListener('change',updatePlanPreview);
$('#item-form').addEventListener('invalid',e=>{if(e.target.closest('#extra-fields'))$('#extra-fields').open=true;},true);
// 快捷键：/ 聚焦搜索，N 新增，Esc 关闭并排详情；输入时与弹窗打开时不拦截。
document.addEventListener('keydown',e=>{
  if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.altKey||$('#ledger').hidden)return;
  const typing=e.target.closest('input,textarea,select,[contenteditable]');
  const modalOpen=['#editor','#renew-dialog','#confirm-dialog'].some(s=>$(s).open)||$('#detail').dataset.modal==='true'&&$('#detail').open;
  if(e.key==='Escape'){if(modalOpen||(typing&&e.target.value))return;if($('#detail').open){e.preventDefault();closeDetail();}return;}
  if(typing||modalOpen||viewKey==='backup')return;
  if(e.key==='/'){e.preventDefault();$('#search').focus();$('#search').select();}
  else if(e.key==='n'||e.key==='N'){e.preventDefault();edit(null);}
});
// 点击遮罩关闭弹窗（原生 dialog 默认只在按 Esc 时关）
for(const d of document.querySelectorAll('dialog'))d.addEventListener('click',e=>{if(e.target===d){const box=d.getBoundingClientRect();if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom){if(d.id==='detail')closeDetail();else d.close();}}});
async function logout(){try{await api('/api/logout','POST',{});location.reload();}catch(e){reportError(e);}}
$('#logout').addEventListener('click',logout);
$('#logout-mobile').addEventListener('click',logout);
// 外观：跟随系统 / 浅色 / 深色。偏好存浏览器本地，theme.js 在首帧前读取。
function applyTheme(mode, animate){
  const root=document.documentElement;
  if(animate){root.classList.add('theme-transition');setTimeout(()=>root.classList.remove('theme-transition'),320);}
  if(mode==='light'||mode==='dark')root.dataset.theme=mode;else delete root.dataset.theme;
  try{if(mode==='system')localStorage.removeItem('ledger-theme');else localStorage.setItem('ledger-theme',mode);}catch(e){/* 私密模式等无法持久化时仍即时生效 */}
  for(const b of document.querySelectorAll('[data-theme-mode]'))b.setAttribute('aria-pressed',String(b.dataset.themeMode===mode));
}
for(const b of document.querySelectorAll('[data-theme-mode]'))b.addEventListener('click',()=>applyTheme(b.dataset.themeMode,true));
applyTheme(document.documentElement.dataset.theme||'system',false);
$('#export').addEventListener('click',async()=>{try{const backup=await api('/api/export');const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`订阅账本-${stats.today}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);try{localStorage.setItem('ledger-last-export',new Date().toISOString());}catch(e){/* 无法持久化时只影响“上次导出”显示 */}renderExportFacts();reportOk('已导出备份 JSON。');}catch(e){reportError(e);}});
/* 导出卡片的事实行：条数、文件名、本浏览器的上次导出时间。 */
function renderExportFacts() {
  $('#export-count').textContent=`${items.length} 条订阅，含全部续费历史`;
  $('#export-name').textContent=stats.today?`订阅账本-${stats.today}.json`:'—';
  let last='';try{last=localStorage.getItem('ledger-last-export')||'';}catch(e){/* 私密模式 */}
  const d=last?new Date(last):null;
  $('#export-last').textContent=d&&!Number.isNaN(d.getTime())?`${friendlyDate(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`:'尚未在此浏览器导出';
}
/* 恢复：选中文件即读取并解析，先给摘要再允许覆盖；服务器仍做完整校验。 */
function fileSize(bytes) { return bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(2)} MB`; }
function showImportSummary(file, summary, error) {
  const box=$('#import-summary');box.replaceChildren();box.hidden=false;box.classList.toggle('error',!!error);
  const copy=text('div','','import-copy');copy.append(text('b',file.name),text('small',error||summary));box.append(copy);
  const clear=action('',clearImport,'icon-btn','close');clear.setAttribute('aria-label','移除所选文件');box.append(clear);
}
function clearImport() { pendingBackup=null;$('#import-file').value='';$('#import-summary').hidden=true;$('#import-summary').replaceChildren();$('#restore').disabled=true;localReport('#restore-status',''); }
async function inspectBackupFile() {
  const file=$('#import-file').files[0];localReport('#restore-status','');pendingBackup=null;$('#restore').disabled=true;
  if(!file){$('#import-summary').hidden=true;return;}
  try{
    if(file.size>2*1024*1024)throw new Error('文件超过 2 MiB');
    let backup;try{backup=JSON.parse(await file.text());}catch(e){throw new Error('不是有效的 JSON 文件');}
    if(!backup||backup.format!=='subscription-ledger'||backup.version!==1||!Array.isArray(backup.items))throw new Error('不是本应用导出的备份（需要 format=subscription-ledger、version=1）');
    const history=Array.isArray(backup.renewals)?backup.renewals.length:0;
    pendingBackup=backup;showImportSummary(file,`${backup.items.length} 条订阅 · ${history} 条续费历史 · ${fileSize(file.size)}`);$('#restore').disabled=false;
  }catch(e){showImportSummary(file,'',e.message||String(e));}
}
$('#import-file').addEventListener('change',inspectBackupFile);
const dropzone=$('#dropzone');
for(const type of ['dragenter','dragover'])dropzone.addEventListener(type,e=>{e.preventDefault();dropzone.classList.add('is-over');});
for(const type of ['dragleave','drop'])dropzone.addEventListener(type,e=>{e.preventDefault();dropzone.classList.remove('is-over');});
dropzone.addEventListener('drop',e=>{const files=e.dataTransfer?.files;if(!files||!files.length)return;$('#import-file').files=files;inspectBackupFile();});
$('#restore').addEventListener('click',async()=>{const button=$('#restore');try{const file=$('#import-file').files[0];if(!file||!pendingBackup)throw new Error('请先选择备份文件');const backup=pendingBackup;const incoming=backup.items.length;
  const ok=await confirmDialog({title:'覆盖并恢复备份？',body:`当前 ${items.length} 条订阅及全部续费历史将被「${file.name}」中的 ${incoming} 条记录替换。`,note:'服务器会先备份现有数据库，恢复后的旧库文件名会显示在这里。',accept:'覆盖并恢复'});
  if(!ok)return;button.disabled=true;localReport('#restore-status','正在恢复…',true);const result=await api('/api/restore','POST',{confirm:true,backup});clearImport();await load();localReport('#restore-status',`恢复完成，旧数据库已备份为 ${result.backup_file}`,true);}catch(e){localReport('#restore-status',e.message||String(e),false);button.disabled=!pendingBackup;}});
(async()=>{try{const s=await api('/api/session');csrf=s.csrf;$('#login-panel').hidden=s.authenticated;$('#ledger').hidden=!s.authenticated;$('#logout').hidden=!s.authenticated;$('#logout-mobile').hidden=!s.authenticated;if(!s.configured)reportError(new Error('尚未设置密码，请在服务器按 README 初始化。'));if(s.authenticated)await load();}catch(e){reportError(e);}})();
