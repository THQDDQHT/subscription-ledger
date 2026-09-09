'use strict';
const $ = s => document.querySelector(s);
const labels = {active:'使用中',cancelling:'准备取消',cancelled:'已取消续费',ended:'已结束'};
let csrf='', items=[], stats={}, windowKey='upcoming_7';
function text(tag, value, cls) { const e=document.createElement(tag); e.textContent=value; if(cls)e.className=cls; return e; }
async function api(url, method='GET', body) {
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok){
    if(response.status===401 && url!=='/api/login'){
      csrf='';items=[];stats={};
      $('#ledger').hidden=true; $('#login-panel').hidden=false; $('#logout').hidden=true;
      for(const s of ['#items','#upcoming'])$(s).replaceChildren();
      for(const s of ['#budget','#forecast','#window-note','#renew-name','#message','#edit-error','#renew-error'])$(s).textContent='';
      for(const s of ['#editor','#renew-dialog'])if($(s).open)$(s).close();
      $('#item-form').reset();$('#renew-form').reset();$('#import-file').value='';
      try{csrf=(await api('/api/session')).csrf;}catch(e){/* Login retries session discovery; private DOM stays cleared. */}
    }
    throw new Error(data.error||`请求失败 ${response.status}`);
  }
  return data;
}
function report(error) { $('#message').textContent=error.message||error; }
function action(label, fn, cls) {const b=text('button',label,cls); b.type='button'; b.addEventListener('click',()=>Promise.resolve().then(fn).catch(report));return b;}
function renderUpcoming() {
 const area=$('#upcoming');area.replaceChildren();
 const rows=stats[windowKey]||[];
 if(!rows.length) area.append(text('p','这个窗口没有待处理项目。','muted'));
 for(const r of rows){const line=text('div','', 'upcoming-row');line.append(text('span',`${r.next_date} · ${r.name}`),text('strong',`¥${r.amount}`));area.append(line);}
}
function renderItems() {
 const area=$('#items');area.replaceChildren(); const filtered=items.filter(r=>$('#filter').value==='all'||r.status===$('#filter').value);
 if(!filtered.length)area.append(text('p',items.length?'此状态暂无订阅。':'还没有订阅。从“新增订阅”开始，所有数据由你录入。','empty'));
 for(const r of filtered){
  const card=text('article','','subscription');const head=text('div','','section-head');head.append(text('h3',r.name),text('strong',`¥${r.amount}`));card.append(head);
  const cycle=r.cycle==='monthly'?'月付':r.cycle==='quarterly'?'季付':r.cycle==='yearly'?'年付':`每 ${r.days} 天`;
  card.append(text('p',`${labels[r.status]} · ${cycle} · ${r.auto_renew?'自动续费已开':'手动续费'}`),text('p',`下次计划：${r.next_date}${r.next_date<stats.today && ['active','cancelling'].includes(r.status)?' · 逾期未确认':''}`));
  if(r.end_date)card.append(text('p',`服务截止：${r.end_date}`)); if(r.notes)card.append(text('p',r.notes,'notes'));
  const buttons=text('div','','actions');buttons.append(action('编辑',()=>edit(r),'secondary'));
  if(['active','cancelling'].includes(r.status))buttons.append(action('已续费',()=>renew(r)));
  if(r.url){const a=text('a','管理订阅');a.href=r.url;a.target='_blank';a.rel='noopener noreferrer';buttons.append(a);}
  buttons.append(action('删除',async()=>{if(confirm(`确定删除「${r.name}」及其续费历史？此操作不可撤销。`)){await api(`/api/items/${r.id}`,'DELETE',{confirm:true});await load();}},'danger secondary'));
  card.append(buttons);area.append(card);
 }
}
async function load() { [items,stats]=await Promise.all([api('/api/items'),api('/api/summary')]);$('#budget').textContent=`¥${stats.monthly_budget}`;$('#forecast').textContent=`¥${stats.forecast_30}`;$('#window-note').textContent=`今天 ${stats.today} · 窗口包含今天，不包含第 7 / 30 天；逾期单列。已取消续费和已结束不计入预算。`;renderItems();renderUpcoming(); }
function cycleField() {const f=$('#item-form');const show=f.elements.cycle.value==='days';$('#days-field').hidden=!show;f.elements.days.required=show;}
function edit(r) {const f=$('#item-form');f.reset();$('#edit-error').textContent='';$('#editor-title').textContent=r?'编辑订阅':'新增订阅';f.elements.id.value=r?.id||''; if(r){for(const key of ['name','amount','cycle','days','next_date','status','end_date','url','notes'])f.elements[key].value=r[key]??'';f.elements.auto_renew.checked=r.auto_renew;}else{f.elements.next_date.value=stats.today;}cycleField();$('#editor').showModal();}
function renew(r) {const f=$('#renew-form');f.reset();f.elements.id.value=r.id;f.elements.actual_date.value=stats.today;f.elements.actual_date.max=stats.today;f.elements.next_date.value=r.suggested_next;$('#renew-name').textContent=r.name;$('#renew-error').textContent='';$('#renew-dialog').showModal();}
async function submitGuard(form, fn, target) {const b=form.querySelector('button[type="submit"]');b.disabled=true;target.textContent='';try{await fn();}catch(e){target.textContent=e.message;}finally{b.disabled=false;}}
$('#login-form').addEventListener('submit',e=>{e.preventDefault();submitGuard(e.target,async()=>{csrf=(await api('/api/session')).csrf;const result=await api('/api/login','POST',{password:e.target.elements.password.value});csrf=result.csrf;e.target.reset();$('#login-panel').hidden=true;$('#ledger').hidden=false;$('#logout').hidden=false;await load();},$('#message'));});
$('#item-form').addEventListener('submit',e=>{e.preventDefault();submitGuard(e.target,async()=>{const f=e.target.elements;const r={};for(const key of ['name','amount','cycle','next_date','status','url','notes'])r[key]=f[key].value;r.days=r.cycle==='days'?Number(f.days.value):null;r.end_date=f.end_date.value||null;r.auto_renew=f.auto_renew.checked;await api(f.id.value?`/api/items/${f.id.value}`:'/api/items',f.id.value?'PUT':'POST',r);$('#editor').close();await load();},$('#edit-error'));});
$('#renew-form').addEventListener('submit',e=>{e.preventDefault();submitGuard(e.target,async()=>{const f=e.target.elements;await api(`/api/items/${f.id.value}/renew`,'POST',{actual_date:f.actual_date.value,next_date:f.next_date.value,confirm:f.confirm.checked});$('#renew-dialog').close();await load();},$('#renew-error'));});
$('#item-form').elements.cycle.addEventListener('change',cycleField);
$('#add').addEventListener('click',()=>edit(null));$('#filter').addEventListener('change',renderItems);
for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>$('#'+b.dataset.close).close());
for(const b of document.querySelectorAll('[data-window]'))b.addEventListener('click',()=>{windowKey=b.dataset.window;document.querySelectorAll('[data-window]').forEach(x=>x.classList.toggle('selected',x===b));renderUpcoming();});
$('#logout').addEventListener('click',async()=>{try{await api('/api/logout','POST',{});location.reload();}catch(e){report(e);}});
$('#export').addEventListener('click',async()=>{try{const backup=await api('/api/export');const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`订阅账本-${stats.today}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){report(e);}});
$('#restore').addEventListener('click',async()=>{const button=$('#restore');try{const file=$('#import-file').files[0];if(!file)throw new Error('请先选择备份文件');if(file.size>2*1024*1024)throw new Error('文件超过 2 MiB');const backup=JSON.parse(await file.text());if(!confirm('恢复将覆盖全部订阅及历史！服务器会先备份现有数据库。确定继续？'))return;button.disabled=true;const result=await api('/api/restore','POST',{confirm:true,backup});await load();report(`恢复完成。旧数据库备份：${result.backup_file}`);$('#import-file').value='';}catch(e){report(e);}finally{button.disabled=false;}});
(async()=>{try{const s=await api('/api/session');csrf=s.csrf;$('#login-panel').hidden=s.authenticated;$('#ledger').hidden=!s.authenticated;$('#logout').hidden=!s.authenticated;if(!s.configured)report('尚未设置密码，请在服务器按 README 初始化。');if(s.authenticated)await load();}catch(e){report(e);}})();
