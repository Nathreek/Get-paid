import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomInt } from 'node:crypto';
import { normalizeHandle, normalizePost } from './dist/model.js';
import { resolveDisplayName } from './dist/profiles.js';
export const PAGE_SIZE=25;
const samples=['Maya Chen','Alex Rivera','Jordan Lee','Sam Parker','Avery Brooks','Riley Morgan','Taylor Quinn','Casey Hayes','Jamie Ellis','Morgan Blake','Charlie Lane'];
export function createStore(filename,{clock=Date.now,delay=()=>randomInt(5000,25001),rotationDelay=()=>randomInt(6000,12001)}={}){
  const db=new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,handle TEXT NOT NULL,post TEXT NOT NULL,display_name TEXT NOT NULL,created_at INTEGER NOT NULL,reveal_at INTEGER NOT NULL,ready_at INTEGER NOT NULL,sent_at INTEGER,shown_at INTEGER,UNIQUE(handle,post));
    CREATE INDEX IF NOT EXISTS submissions_created ON submissions(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS submissions_ready ON submissions(ready_at,shown_at);
    CREATE INDEX IF NOT EXISTS submissions_owner ON submissions(owner);
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT OR IGNORE INTO metadata VALUES('revision','0');`);
  const sql={
    count:db.prepare('SELECT count(*) AS total FROM submissions'),
    rows:db.prepare('SELECT * FROM submissions ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?'),
    find:db.prepare('SELECT * FROM submissions WHERE id=?'),
    duplicate:db.prepare('SELECT id FROM submissions WHERE handle=? AND post=?'),
    insert:db.prepare('INSERT INTO submissions(id,owner,handle,post,display_name,created_at,reveal_at,ready_at) VALUES(?,?,?,?,?,?,?,?)'),
    remove:db.prepare('DELETE FROM submissions WHERE id=? AND owner=?'),
    revision:db.prepare("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'"),
    meta:db.prepare('SELECT value FROM metadata WHERE key=?'),
    setMeta:db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
    unseen:db.prepare('SELECT * FROM submissions WHERE ready_at<=? AND shown_at IS NULL ORDER BY ready_at,id LIMIT 1'),
    oldest:db.prepare('SELECT * FROM submissions WHERE ready_at<=? ORDER BY shown_at,id LIMIT 1'),
    shown:db.prepare('UPDATE submissions SET shown_at=? WHERE id=?'),
    sent:db.prepare('UPDATE submissions SET sent_at=? WHERE id=? AND sent_at IS NULL AND ready_at<=?'),
    waitingNames:db.prepare('SELECT display_name FROM submissions WHERE ready_at>?'),
  };
  const record=(row,owner)=>({id:row.id,handle:row.handle,post:row.post,displayName:row.display_name,createdAt:row.created_at,revealAt:row.reveal_at,readyAt:row.ready_at,...(row.sent_at===null?{}:{sentAt:row.sent_at}),canDelete:row.owner===owner});
  function spotlight(){
    const now=clock();
    let current;try{current=JSON.parse(sql.meta.get('spotlight')?.value||'null');}catch{}
    // A selected name remains visible for its slot. New ready names take the next slot.
    if(current&&current.nextAt>now&&(!current.recordId||sql.find.get(current.recordId)))return current;
    let next=sql.unseen.get(now);
    if(!next&&!current?.recordId)next=sql.oldest.get(now);
    if(next){sql.shown.run(now,next.id);current={name:next.display_name,recordId:next.id,changedAt:now,nextAt:now+rotationDelay()};}
    else{
      const waiting=new Set(sql.waitingNames.all(now).map(row=>row.display_name));
      const pool=samples.filter(name=>name!==current?.name&&!waiting.has(name));
      current={name:pool.length?pool[randomInt(pool.length)]:'Your name could be next',recordId:null,changedAt:now,nextAt:now+rotationDelay()};
    }
    sql.setMeta.run('spotlight',JSON.stringify(current));return current;
  }
  return {
    async add(owner,postValue,handleValue){
      const handle=normalizeHandle(handleValue),post=normalizePost(postValue);
      const displayName=await resolveDisplayName(handle);
      if(sql.duplicate.get(handle,post)){const error=new Error('That post and handle are already in the shared list.');error.status=409;throw error;}
      const now=clock(),id=randomUUID(),revealAt=now+delay();
      sql.insert.run(id,owner,handle,post,displayName,now,revealAt,revealAt+60000);sql.revision.run();
      return record(sql.find.get(id),owner);
    },
    state(owner,requestedPage=0){
      const total=sql.count.get().total,pages=Math.max(1,Math.ceil(total/PAGE_SIZE)),page=Math.min(pages-1,Math.max(0,requestedPage));
      return {serverNow:clock(),total,page,pages,pageSize:PAGE_SIZE,records:sql.rows.all(PAGE_SIZE,page*PAGE_SIZE).map(row=>record(row,owner)),spotlight:spotlight(),revision:Number(sql.meta.get('revision').value)};
    },
    acknowledge(id){
      // The browser calls this only after rendering the current shared top-box name.
      const current=spotlight(),now=clock();
      if(current.recordId!==id)return false;
      if(sql.sent.run(now,id,now).changes)sql.revision.run();return true;
    },
    remove(owner,id){const changed=sql.remove.run(id,owner).changes;if(changed)sql.revision.run();return Boolean(changed);},
    close(){db.close();}
  };
}
