// Exercise the production selection logic against date boundaries and a large ledger.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('static/app.js','utf8').split("$('#login-form').addEventListener")[0];
const context=vm.createContext({console,URLSearchParams});vm.runInContext(source,context);
const run=s=>vm.runInContext(s,context);
run(`stats={today:'2026-09-12',upcoming_30:Array(30).fill({id:'daily'})};
items=[
{id:'past',name:'Past',notes:'',status:'active',next_date:'2026-09-11',amount_cents:900},
{id:'today',name:'Today',notes:'',status:'active',next_date:'2026-09-12',amount_cents:100},
{id:'six',name:'Six',notes:'',status:'cancelling',next_date:'2026-09-18',amount_cents:500},
{id:'seven',name:'Seven',notes:'',status:'active',next_date:'2026-09-19',amount_cents:800},
{id:'last',name:'Last',notes:'',status:'active',next_date:'2026-10-11',amount_cents:300},
{id:'outside',name:'Outside',notes:'',status:'active',next_date:'2026-10-12',amount_cents:700},
{id:'cancelled',name:'Cancelled',notes:'',status:'cancelled',next_date:'2026-09-12',amount_cents:200},
{id:'daily',name:'Daily',notes:'特殊备注',status:'active',next_date:'2026-09-12',amount_cents:400}
];`);
const ids=()=>JSON.parse(run('JSON.stringify(selectGroups().map(g=>[g.key,g.rows.map(r=>r.id)]))'));
assert.deepEqual(ids(),[['recent:overdue',['past']],['recent:week',['daily','today','six']],['recent:month',['seven','last']]]);
assert.equal(run("selectGroups().flatMap(g=>g.rows).filter(r=>r.id==='daily').length"),1,'forecast expansion must not duplicate renewal actions');
run("keyword=' 特殊备注 '");assert.deepEqual(ids(),[['recent:week',['daily']]]);
run("viewKey='all';keyword='cAnCeL';filterKey='cancelled'");assert.deepEqual(ids(),[['all:cancelled',['cancelled']]]);
run("keyword='';filterKey='active';sortKey='amount'");assert.deepEqual(ids()[0][1],['past','seven','outside','daily','last','today']);
run("items=Array.from({length:120},(_,i)=>({id:String(i),name:'服务'+i,notes:'',status:'active',next_date:'2026-09-12',amount_cents:i}));keyword='';filterKey='all'");
assert.equal(run('selectGroups().flatMap(g=>g.rows).length'),120);
run("keyword='不会匹配'");assert.equal(run('selectGroups().length'),0);
console.log('PASS recent date boundaries, unique renewal entries, note/name search, status/amount sorting, 120 records and empty results');

assert.deepEqual(JSON.parse(run("JSON.stringify(parseRoute('#all?item=abc'))")),{view:'all',id:'abc'});
assert.deepEqual(JSON.parse(run("JSON.stringify(parseRoute('#backup?item=abc'))")),{view:'backup',id:''});
assert.equal(run("parseRoute('#unknown').view"),'recent');
assert.equal(run("routeURL('all','a b')"),'#all?item=a%20b');
run("viewKey='recent';keyword='';filterKey='cancelled'");assert.equal(run('selectGroups().length'),0);
console.log('PASS navigation parsing, detail links and recent status filtering');

// 展示口径：金额千分位、中文日期与相对天数；记录本身仍是 ISO。
run("stats={today:'2026-09-12'}");
assert.equal(run("money('138.00')"),'¥138.00');
assert.equal(run("money('34323.97')"),'¥34,323.97');
assert.equal(run("money('1234567.5')"),'¥1,234,567.5');
assert.equal(run("moneyCents(77600)"),'¥776.00');
assert.equal(run("friendlyDate('2026-09-08')"),'9月8日 周二');
assert.equal(run("friendlyDate('2027-01-31')"),'2027年1月31日 周日');
assert.equal(run("friendlyDate('')"),'');
assert.deepEqual(JSON.parse(run("JSON.stringify(relativeDay('2026-09-08'))")),{text:'逾期 4 天',cls:'overdue'});
assert.deepEqual(JSON.parse(run("JSON.stringify(relativeDay('2026-09-12'))")),{text:'今天',cls:'soon'});
assert.deepEqual(JSON.parse(run("JSON.stringify(relativeDay('2026-09-13'))")),{text:'明天',cls:'soon'});
assert.deepEqual(JSON.parse(run("JSON.stringify(relativeDay('2026-09-18'))")),{text:'还剩 6 天',cls:'soon'});
assert.deepEqual(JSON.parse(run("JSON.stringify(relativeDay('2026-09-19'))")),{text:'还剩 7 天',cls:''});
console.log('PASS money grouping, Chinese dates with weekday, relative day boundaries');
