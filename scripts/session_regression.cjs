// Execute the real frontend API helper with a minimal DOM/network harness.
const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict');
const nodes=new Map();
function node(s){if(!nodes.has(s))nodes.set(s,{hidden:false,textContent:'private',value:'private',open:true,replaceChildren(){this.textContent='';},reset(){this.value='';},close(){this.open=false;}});return nodes.get(s);}
let responses=[];
const context=vm.createContext({document:{querySelector:node},fetch:async()=>{const r=responses.shift();if(r instanceof Error)throw r;return {ok:r.status===200,status:r.status,json:async()=>r.body};},console});
const source=fs.readFileSync('static/app.js','utf8').split("$('#login-form').addEventListener")[0];
vm.runInContext(source,context);
(async()=>{
 for(const failRefresh of [false,true]){
  vm.runInContext("csrf='stale';items=[{name:'secret'}];stats={today:'secret'}",context);
  responses=[{status:401,body:{error:'expired'}},failRefresh?new Error('offline'):{status:200,body:{csrf:'fresh'}}];
  await assert.rejects(vm.runInContext("api('/api/items')",context));
  assert.equal(vm.runInContext('csrf',context),failRefresh?'':'fresh');
  assert.equal(node('#ledger').hidden,true);
  assert.equal(node('#items').textContent,'');
  assert.equal(node('#upcoming').textContent,'');
  assert.equal(node('#editor').open,false);
  assert.equal(node('#renew-dialog').open,false);
  assert.equal(vm.runInContext('items.length',context),0);
 }
 console.log('PASS expired session refreshes CSRF; offline failure clears private DOM/dialogs/state');
})().catch(e=>{console.error(e);process.exitCode=1;});
