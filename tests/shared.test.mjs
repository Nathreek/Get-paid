import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createStore, payoutCents, TIERS, TIER_SIZE } from '../store.mjs';
import { createAppServer } from '../http-server.mjs';
import { normalizeHandle, readRecords } from '../dist/model.js';
test('punctuation explains the actual validation problem',()=>{
  assert.throws(()=>normalizeHandle('RTTWE!'),/Remove “!”/);
  assert.equal(normalizeHandle('RTTWE'),'rttwe');
});
test('legacy import reader preserves 5,000 valid browser entries without truncation',()=>{
  const rows=Array.from({length:5000},(_,i)=>({id:`entry-${i}`,handle:`person${i}`,post:`https://x.com/person${i}/status/${i+1}`,displayName:`Person ${i}`,createdAt:1000,revealAt:20000}));
  assert.equal(readRecords({getItem:()=>JSON.stringify(rows)},25000).length,5000);
});
test('shared pagination, ownership, 60-second gate and actual top acknowledgement',async()=>{
  let time=100000;const store=createStore(':memory:',{clock:()=>time,delay:()=>5000,rotationDelay:()=>6000});
  try{
    const row=await store.add('owner-a','https://x.com/alpha/status/123','alpha');
    for(let i=0;i<30;i++)await store.add('owner-b',`https://x.com/person${i}/status/${i+1}`,`person${i}`);
    const state=store.state('owner-a');assert.equal(state.total,31);assert.equal(state.records.length,25);assert.equal(store.state('owner-a',1).records.length,6);
    assert.equal(store.remove('owner-b',row.id),false);
    time=164999;assert.equal(store.acknowledge(row.id),false);assert.equal(store.state('owner-a').spotlight.recordId,null);
    time=171000;let shown=store.state('owner-a').spotlight;assert.ok(shown.recordId);assert.equal(store.acknowledge(shown.recordId),true);
    const records=[...store.state('owner-a').records,...store.state('owner-a',1).records];assert.ok(records.find(record=>record.id===shown.recordId).sentAt>=165000);
    await assert.rejects(()=>store.add('another','https://x.com/alpha/status/123','ALPHA'),/already/);
  }finally{store.close();}
});
test('database survives close and reopen',async()=>{
  const file=path.join(tmpdir(),`get-paid-test-${randomUUID()}.sqlite`);
  let store=createStore(file);await store.add('owner','https://x.com/persist/status/123','persist');store.close();
  store=createStore(file);assert.equal(store.state('owner').total,1);store.close();
  for(const suffix of ['','-wal','-shm'])await unlink(file+suffix).catch(()=>{});
});
test('visitors share entries; API rejects cross-site writes, limits abuse, and protects deletion',async()=>{
  const store=createStore(':memory:');const server=createAppServer({directory:fileURLToPath(new URL('../dist/',import.meta.url)),store,rateLimit:3});server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const a=await fetch(base+'/api/state'),cookie=a.headers.get('set-cookie').split(';')[0];await a.json();
    const headers={'Content-Type':'application/json',Origin:base,Cookie:cookie};
    const create=await fetch(base+'/api/submissions',{method:'POST',headers,body:JSON.stringify({post:'https://x.com/valid/status/123',handle:'valid'})});assert.equal(create.status,201);const {record}=await create.json();
    const other=await fetch(base+'/api/state');const otherCookie=other.headers.get('set-cookie').split(';')[0];const shared=await other.json();assert.equal(shared.total,1);assert.equal(shared.records[0].canDelete,false);
    assert.equal((await fetch(base+`/api/submissions/${record.id}`,{method:'DELETE',headers:{...headers,Cookie:otherCookie}})).status,404);
    assert.equal((await fetch(base+'/api/submissions',{method:'POST',headers:{...headers,Origin:'https://unrelated.example'},body:'{}'})).status,403);
    const invalid=await fetch(base+'/api/submissions',{method:'POST',headers,body:JSON.stringify({post:'https://x.com/valid/status/123',handle:'RTTWE!'})});assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/Remove “!”/);
    await fetch(base+'/api/submissions',{method:'POST',headers,body:'{}'});
    assert.equal((await fetch(base+'/api/submissions',{method:'POST',headers,body:'{}'})).status,429);
    const css=await fetch(base+'/styles.css'),tag=css.headers.get('etag');assert.equal(css.status,200);await css.text();assert.equal((await fetch(base+'/styles.css',{headers:{'If-None-Match':tag}})).status,304);
    const image=await fetch(base+'/assets/gp-monogram.png');assert.equal(image.headers.get('content-type'),'image/png');await image.arrayBuffer();
    assert.equal((await fetch(base+'/data/submissions.sqlite')).status,404);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
});
test('payouts start at $3–5, climb through tiers, never decrease and cap at $40',()=>{
  let previous=0;
  for(let position=0;position<TIERS.length*TIER_SIZE+50;position++){
    const cents=payoutCents(position,previous),[low,high]=TIERS[Math.min(TIERS.length-1,Math.floor(position/TIER_SIZE))];
    assert.ok(cents>=low&&cents<=high&&cents>=previous,`position ${position}: ${cents}`);previous=cents;
  }
  assert.ok(payoutCents(0)<=500);assert.equal(previous<=4000,true);
});
test('featured names keep their assigned payout',async()=>{
  let time=100000;const store=createStore(':memory:',{clock:()=>time,delay:()=>5000,rotationDelay:()=>6000});
  try{
    await store.add('owner','https://x.com/first/status/1','first');await store.add('owner','https://x.com/second/status/2','second');
    time=166000;const one=store.state('owner').spotlight;assert.ok(one.amountCents>=300&&one.amountCents<=500);
    time=173000;const two=store.state('owner').spotlight;assert.notEqual(two.recordId,one.recordId);assert.ok(two.amountCents>=one.amountCents);
    time=180000;assert.equal(store.state('owner').spotlight.amountCents,undefined);
    time=187000;const again=store.state('owner').spotlight;assert.equal(again.amountCents,again.recordId===one.recordId?one.amountCents:two.amountCents);
    assert.equal(store.state('owner').records.find(record=>record.id===one.recordId).amountCents,one.amountCents);
  }finally{store.close();}
});
