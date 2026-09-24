import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHandle, normalizePost, randomDelay, readRecords } from '../dist/model.js';
import { resolveDisplayName } from '../dist/profiles.js';
test('post validation accepts legacy Twitter URLs, strips tracking, and rejects deceptive hosts',()=>{
  assert.equal(normalizePost('https://www.twitter.com/test/status/123?s=20'),'https://x.com/test/status/123');
  for(const bad of ['javascript:alert(1)','https://x.com.evil.test/a/status/123','https://evil.test/x.com/a/status/123','http://x.com/a/status/123','https://x.com/a','https://user:pass@x.com/a/status/123'])assert.throws(()=>normalizePost(bad));
});
test('handles normalize and exclude markup or invalid identity syntax',()=>{
  assert.equal(normalizeHandle(' @Sam_Builds '),'sam_builds');
  for(const bad of ['', '@@sam','a b','<script>','longerthan15characters','https://x.com/a'])assert.throws(()=>normalizeHandle(bad));
});
test('random timing stays in the promised 5–25 second interval',()=>{
  assert.equal(randomDelay(5000,25000,()=>0),5000);
  assert.equal(randomDelay(5000,25000,()=>.999999),25000);
  const delays=new Set(Array.from({length:200},()=>randomDelay(5000,25000)));
  assert.ok(delays.size>1);assert.ok([...delays].every(d=>d>=5000&&d<=25000));
});
test('saved pending deadlines survive reload; untrusted corrupted entries are excluded',()=>{
  const good={id:'1',handle:'sam_builds',post:'https://x.com/sam_builds/status/123',displayName:'Sam Parker',createdAt:10000,revealAt:23000};
  const storage={getItem:()=>JSON.stringify([good,{...good,post:'javascript:alert(1)'},{...good,revealAt:999999}])};
  assert.deepEqual(readRecords(storage,15000),[good]);
  assert.deepEqual(readRecords(storage,24000),[good]);
  assert.throws(()=>readRecords({getItem:()=>'{bad'}));
});
test('display names are derived from the handle',async()=>{
  assert.equal(await resolveDisplayName('sam_builds'),'Sam Builds');
  assert.equal(await resolveDisplayName('jane_doe'),'Jane Doe');
});
