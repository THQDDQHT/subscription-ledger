'use strict';
const $ = s => document.querySelector(s);
const labels = {active:'使用中',cancelling:'准备取消',cancelled:'已取消续费',ended:'已结束'};
let csrf='', items=[], stats={}, viewKey='recent', filterKey='all', focusKey='', keyword='', sortKey='date';
const collapsedGroups=new Set(['recent:month','all:cancelled','all:ended']);
let reportTimer, selectedId='', displayedDetailId='';

function text(tag, value, cls) { const e=document.createElement(tag); e.textContent=value; if(cls)e.className=cls; return e; }
function icon(id) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('aria-hidden','true');
  const use=document.createElementNS('http://www.w3.org/2000/svg','use');
  use.setAttribute('href','#i-'+id);
  svg.append(use);
  return svg;
}
async function api(url, method='GET', body) {
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok){
    if(response.status===401 && url!=='/api/login'){
      csrf='';items=[];stats={};focusKey='';filterKey='all';viewKey='recent';keyword='';sortKey='date';collapsedGroups.clear();
      selectedId='';displayedDetailId='';history.replaceState(null,'',location.pathname+location.search);
      $('#search').value='';$('#sort').value='date';$('#filter').value='all';
      $('#ledger').hidden=true; $('#login-panel').hidden=false; $('#logout').hidden=true;
      for(const s of ['#items','#detail-body','#detail-actions'])$(s).replaceChildren();
      for(const s of ['#budget','#forecast','#window-note','#renew-name','#renew-diff','#message','#edit-error','#renew-error','#restore-status','#detail-title','#result-count','#recent-count','#all-count','#plan-preview','#overdue-count'])$(s).textContent='';
      $('#message').className='';
      for(const s of ['#editor','#renew-dialog','#detail'])if($(s).open)$(s).close();
      $('#item-form').reset();$('#renew-form').reset();$('#import-file').value='';$('#restore').disabled=true;
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

function action(label, fn, cls, iconId, key) {
  const b=text('button',label,cls); b.type='button';
  if(iconId) b.prepend(icon(iconId));
  if(key) b.dataset.key=key;
  b.addEventListener('click',()=>Promise.resolve().then(fn).catch(reportError));
  return b;
}
function cycleLabel(r) { return r.cycle==='monthly'?'月付':r.cycle==='quarterly'?'季付':r.cycle==='yearly'?'年付':`每 ${r.days} 天`; }
function dayLabel(dateStr) {
  if(!stats.today) return '';
  const days=(Date.parse(dateStr+'T00:00:00Z')-Date.parse(stats.today+'T00:00:00Z'))/86400000;
  if(days<0) return ' · 逾期未确认';
  if(days===0) return ' · 今天';
  if(days===1) return ' · 明天';
  return ` · 还剩 ${days} 天`;
}
function emptyState(title, desc) {
  const box=text('div','','empty');
  box.append(text('b',title));
  if(desc) box.append(text('span',desc));
  return box;
}
// 近期按订阅的当前计划分组；预测事件只用于统计，不生成重复操作。
function daysUntil(dateStr) {return (Date.parse(dateStr+'T00:00:00Z')-Date.parse(stats.today+'T00:00:00Z'))/86400000;}
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
  const title=action('',()=>showDetail(r),'row-title',null,`${r.id}:detail`);
  const avatar=text('span',Array.from(r.name)[0]||'订','avatar avatar--'+r.status);avatar.setAttribute('aria-hidden','true');
  const name=text('span','','row-name');name.append(text('span',r.name,'service-name'));
  const subline=text('span','','row-subline');subline.append(text('small',r.auto_renew?'自动续费已开':'手动续费'));name.append(subline);
  title.append(avatar,name);title.setAttribute('aria-label',`查看 ${r.name} 的详情`);
  const amount=text('div','','row-amount');amount.append(text('strong',`¥${r.amount}`),text('small',cycleLabel(r)));
  const date=text('div','',isActive(r)&&daysUntil(r.next_date)<0?'row-date overdue':'row-date');
  date.append(text('span',isActive(r)?r.next_date:(r.end_date||'—')),text('small',isActive(r)?dayLabel(r.next_date).replace(' · ',''):(r.end_date?'服务截止':'不再计入预算')));
  const controls=text('div','','row-actions');
  const more=action('›',()=>showDetail(r),'icon-btn',null,`${r.id}:more`);more.setAttribute('aria-label',`${r.name} 的更多操作`);controls.append(more);
  row.append(title,amount,date,text('span',labels[r.status],`chip chip--${r.status}`),controls);return row;
}
function renderItems() {
  const area=$('#items');area.replaceChildren();
  const groups=selectGroups();const total=groups.reduce((n,g)=>n+g.rows.length,0);
  $('#result-count').textContent=`${keyword.trim()?'找到':'共'} ${total} 项订阅`;
  $('#clear-search').hidden=!keyword;
  if(!total){area.append(emptyState(items.length?'这里暂时没有订阅':'从第一份订阅开始',keyword.trim()?'试试其他名称或备注关键词。':viewKey==='recent'?'当前没有 30 天内待处理的计划，可以在全部订阅中查看。':'点击新增订阅，记录费用与下次续费日期。'));}
  for(const group of groups){
    const section=text('details','','subscription-group');section.open=keyword.trim()?true:!collapsedGroups.has(group.key);
    const heading=text('summary','','group-heading');heading.append(text('span',group.title),text('span',String(group.rows.length),'count'));section.append(heading);
    section.addEventListener('toggle',()=>{if(keyword.trim()||!section.isConnected)return;if(section.open)collapsedGroups.delete(group.key);else collapsedGroups.add(group.key);});
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
  const result=await Promise.all([api('/api/items'),api('/api/summary')]);
  [items,stats]=result;
  $('#budget').textContent=`¥${stats.monthly_budget}`;$('#forecast').textContent=`¥${stats.forecast_30}`;
  $('#overdue-count').textContent=`${items.filter(r=>isActive(r)&&daysUntil(r.next_date)<0).length} 项`;
  $('#window-note').textContent=`今天 ${stats.today} · 中国标准时间`;
  const route=parseRoute(location.hash);viewKey=route.view;selectedId=route.id;
  renderViews();
}
function syncDetailMode() {
  const d=$('#detail');if(!selectedId||$('#ledger').hidden||$('#editor').open||$('#renew-dialog').open)return;
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
  body.append(text('span',labels[r.status],`chip chip--${r.status}`),text('p',`¥${r.amount}`,'detail-amount'),text('p',cycleLabel(r),'muted'));
  const plan=text('div','','detail-plan');plan.append(text('span',isActive(r)?'当前待确认计划':'原计划日期'),text('strong',r.next_date+(isActive(r)?dayLabel(r.next_date):'')));body.append(plan);
  const list=text('dl','','detail-facts');
  for(const [label,value] of [['续费方式',r.auto_renew?'自动续费已开':'手动续费'],['计入预算',isActive(r)?'是':'否'],['服务可用截止日',r.end_date||'未填写']])list.append(text('dt',label),text('dd',value));body.append(list);
  if(r.url){const a=text('a','前往管理订阅','detail-link');a.href=r.url;a.target='_blank';a.rel='noopener noreferrer';a.append(icon('external'));body.append(a);}
  body.append(text('h3','备注'),text('p',r.notes||'暂无备注','detail-notes'));
  const remove=action('删除订阅',async()=>{if(!confirm(`确定删除「${r.name}」及其续费历史？此操作不可撤销。`))return;remove.disabled=true;try{await api(`/api/items/${r.id}`,'DELETE',{confirm:true});closeDetail();await load();reportOk(`已删除「${r.name}」`);}finally{remove.disabled=false;}},'quiet danger-text','trash');
  body.append(remove);
  const controls=$('#detail-actions');controls.replaceChildren();controls.append(action('编辑订阅',()=>edit(r),'ghost','edit'));
  if(isActive(r))controls.append(action('记录续费',()=>renew(r),'','renew'));
  syncDetailMode();body.scrollTop=scroll;
}
function updatePlanPreview() {
  const f=$('#item-form').elements;
  $('#plan-preview').textContent=f.amount.value&&f.next_date.value?`${cycleLabel({cycle:f.cycle.value,days:f.days.value||'…'})} · 每期 ¥${f.amount.value} · 下次 ${f.next_date.value}`:'填写费用与日期，建立你的续费计划。';
}
function cycleField() {const f=$('#item-form');const show=f.elements.cycle.value==='days';$('#days-field').hidden=!show;f.elements.days.required=show;}
function edit(r) {const f=$('#item-form');f.reset();$('#edit-error').textContent='';$('#editor-title').textContent=r?'编辑订阅':'新增订阅';f.elements.id.value=r?.id||''; if(r){for(const key of ['name','amount','cycle','days','next_date','status','end_date','url','notes'])f.elements[key].value=r[key]??'';f.elements.auto_renew.checked=r.auto_renew;}else{f.elements.next_date.value=stats.today;}cycleField();$('#extra-fields').open=Boolean(r&&(r.notes||r.url||r.end_date));updatePlanPreview();$('#editor').showModal();}
function renew(r) {
  const f=$('#renew-form');f.reset();f.elements.id.value=r.id;
  f.elements.actual_date.value=stats.today;f.elements.actual_date.max=stats.today;
  f.elements.next_date.value=r.suggested_next;
  $('#renew-name').textContent=r.name;
  // 显示被替换的原值，避免用户必须记住背后卡片上的日期
  $('#renew-diff').textContent=`当前计划日期：${r.next_date} · 每期 ¥${r.amount}（${cycleLabel(r)}）`;
  $('#renew-error').textContent='';
  $('#renew-dialog').showModal();
}
async function submitGuard(form, fn, target) {const b=form.querySelector('button[type="submit"]');const original=b.textContent;b.disabled=true;b.textContent='保存中…';target.textContent='';try{await fn();}catch(e){target.textContent=e.message;}finally{b.disabled=false;b.textContent=original;}}
$('#login-form').addEventListener('submit',e=>{e.preventDefault();submitGuard(e.target,async()=>{csrf=(await api('/api/session')).csrf;const result=await api('/api/login','POST',{password:e.target.elements.password.value});csrf=result.csrf;e.target.reset();$('#login-panel').hidden=true;$('#ledger').hidden=false;$('#logout').hidden=false;await load();},$('#message'));});
$('#item-form').addEventListener('submit',e=>{e.preventDefault();submitGuard(e.target,async()=>{const f=e.target.elements;const r={};for(const key of ['name','amount','cycle','next_date','status','url','notes'])r[key]=f[key].value;r.days=r.cycle==='days'?Number(f.days.value):null;r.end_date=f.end_date.value||null;r.auto_renew=f.auto_renew.checked;const editing=f.id.value;clearReport();await api(editing?`/api/items/${editing}`:'/api/items',editing?'PUT':'POST',r);$('#editor').close();focusKey=editing?`${editing}:detail`:'';try{await load();}catch(error){reportError('已保存，但列表刷新失败：'+error.message);return;}reportOk(editing?`已保存「${r.name}」`:`已新增「${r.name}」`);},$('#edit-error'));});
$('#renew-form').addEventListener('submit',e=>{e.preventDefault();submitGuard(e.target,async()=>{const f=e.target.elements;const r=items.find(x=>x.id===f.id.value);clearReport();await api(`/api/items/${f.id.value}/renew`,'POST',{actual_date:f.actual_date.value,next_date:f.next_date.value,confirm:f.confirm.checked});$('#renew-dialog').close();focusKey=`${f.id.value}:renew`;try{await load();}catch(error){reportError('已记录续费，但列表刷新失败：'+error.message);return;}reportOk(`已续费「${r?r.name:'订阅'}」· 下次 ${f.next_date.value}`);},$('#renew-error'));});
$('#item-form').elements.cycle.addEventListener('change',cycleField);
$('#add').addEventListener('click',()=>edit(null));
for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>$('#'+b.dataset.close).close());
window.addEventListener('hashchange',readRoute);
window.matchMedia('(max-width:1279px)').addEventListener('change',syncDetailMode);
$('#close-detail').addEventListener('click',closeDetail);
for(const id of ['#editor','#renew-dialog'])$(id).addEventListener('close',syncDetailMode);
$('#detail').addEventListener('cancel',e=>{e.preventDefault();closeDetail();});
$('#collapse-nav').addEventListener('click',()=>{const collapsed=$('#ledger').classList.toggle('nav-collapsed');$('#collapse-nav').setAttribute('aria-expanded',String(!collapsed));$('#collapse-nav').setAttribute('aria-label',collapsed?'展开导航':'收起导航');});
$('#filter').addEventListener('change',e=>{filterKey=e.target.value;$('#list-scroll').scrollTop=0;renderItems();});
$('#search').addEventListener('input',e=>{keyword=e.target.value;$('#list-scroll').scrollTop=0;renderItems();});
$('#clear-search').addEventListener('click',()=>{keyword='';$('#search').value='';renderItems();$('#search').focus();});
$('#sort').addEventListener('change',e=>{sortKey=e.target.value;renderItems();});
$('#item-form').addEventListener('input',updatePlanPreview);
$('#item-form').addEventListener('change',updatePlanPreview);
$('#item-form').addEventListener('invalid',e=>{if(e.target.closest('#extra-fields'))$('#extra-fields').open=true;},true);
// 点击遮罩关闭弹窗（原生 dialog 默认只在按 Esc 时关）
for(const d of document.querySelectorAll('dialog'))d.addEventListener('click',e=>{if(e.target===d){const box=d.getBoundingClientRect();if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom){if(d.id==='detail')closeDetail();else d.close();}}});
async function logout(){try{await api('/api/logout','POST',{});location.reload();}catch(e){reportError(e);}}
$('#logout').addEventListener('click',logout);
$('#logout-mobile').addEventListener('click',logout);
$('#export').addEventListener('click',async()=>{try{const backup=await api('/api/export');const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`订阅账本-${stats.today}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);reportOk('已导出备份 JSON。');}catch(e){reportError(e);}});
$('#import-file').addEventListener('change',()=>{$('#restore').disabled=!$('#import-file').files.length;localReport('#restore-status','');});
$('#restore').addEventListener('click',async()=>{const button=$('#restore');try{const file=$('#import-file').files[0];if(!file)throw new Error('请先选择备份文件');if(file.size>2*1024*1024)throw new Error('文件超过 2 MiB');const backup=JSON.parse(await file.text());if(!confirm('恢复将覆盖全部订阅及历史！服务器会先备份现有数据库。确定继续？'))return;button.disabled=true;localReport('#restore-status','正在恢复…',true);const result=await api('/api/restore','POST',{confirm:true,backup});await load();localReport('#restore-status',`恢复完成，旧数据库已备份为 ${result.backup_file}`,true);$('#import-file').value='';}catch(e){localReport('#restore-status',e.message||String(e),false);}finally{button.disabled=!$('#import-file').files.length;}});
(async()=>{try{const s=await api('/api/session');csrf=s.csrf;$('#login-panel').hidden=s.authenticated;$('#ledger').hidden=!s.authenticated;$('#logout').hidden=!s.authenticated;if(!s.configured)reportError(new Error('尚未设置密码，请在服务器按 README 初始化。'));if(s.authenticated)await load();}catch(e){reportError(e);}})();
