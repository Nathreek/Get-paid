import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpotlightPicker } from '../dist/spotlight.js';
import { spotlightReadyAt, submissionStatus } from '../dist/submission-state.js';
const samples = ['Sample One','Sample Two'];
const record = (id,name,revealAt) => ({id,displayName:name,revealAt});
test('saved submitted name is featured first and returns on alternate turns',()=>{
  const picker=createSpotlightPicker(samples,()=>0), records=[record('user','Randoom112',10)];
  assert.equal(picker.next(records,60010),'Randoom112');
  assert.equal(picker.next(records,60011),'Sample One');
  assert.equal(picker.next(records,60012),'Randoom112');
});
test('pending names stay hidden; newly revealed names take the next turn',()=>{
  const picker=createSpotlightPicker(samples,()=>0), records=[record('user','New Person',100)];
  assert.equal(picker.hasNew(records,60099),false);
  assert.equal(picker.next(records,60099),'Sample One');
  assert.equal(picker.hasNew(records,60100),true);
  assert.equal(picker.next(records,60100),'New Person');
  assert.equal(picker.hasNew(records,60100),false);
  assert.equal(picker.selectedRecordId,'user');
});
test('every submitted name receives a turn even when randomness never changes',()=>{
  const picker=createSpotlightPicker(samples,()=>0);
  const records=[record('a','Alice',1),record('b','Bob',1),record('c','Charlie',1)];
  assert.deepEqual(Array.from({length:9},()=>picker.next(records,60002)),['Alice','Bob','Charlie','Sample One','Alice','Sample One','Bob','Sample One','Charlie']);
  assert.notEqual(picker.next([],60003),'Charlie');
});
test('Pending starts after queueing and stays Pending until an actual top appearance',()=>{
  const pending=record('user','Test User',25000);
  assert.equal(spotlightReadyAt(pending),85000);
  assert.equal(submissionStatus(pending,24999),'queued');
  assert.equal(submissionStatus(pending,25000),'pending');
  assert.equal(submissionStatus(pending,85001),'pending');
  const sent={...pending,sentAt:85002};
  assert.equal(submissionStatus(sent,85002),'sent');
  assert.equal(submissionStatus(JSON.parse(JSON.stringify(sent)),90000),'sent');
});
test('reload cannot skip the one-minute wait or accidentally select a matching sample',()=>{
  const pending=record('user','Sample One',100);
  for(const now of [100,30000,60099]){
    const picker=createSpotlightPicker(samples,()=>0);
    assert.equal(picker.next([pending],now),'Sample Two');
    assert.equal(picker.selectedRecordId,null);
  }
  assert.equal(createSpotlightPicker(samples).next([pending],60100),'Sample One');
});
