import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
// background(promise) keeps work running after the response (Vercel's waitUntil); locally it just lets the promise run.
// Launched coins live at /coin/<mint address> and reuse the main page; everything else about them comes from the API.
const PAYOUT_NUDGE_MS=3000;
const COIN_ID=/^(main|[1-9A-HJ-NP-Za-km-z]{32,44})$/,PAGES={'/':'/index.html','/explore':'/coins.html','/coins':'/coins.html','/launch':'/launch.html'};
export function createAppServer({directory,store,launcher=null,rateLimit=5,trustProxy=false,background=promise=>promise}){
  const root=path.resolve(directory),cache=new Map(),limits=new Map();
  function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));}
  const clientIp=req=>(trustProxy&&String(req.headers['x-forwarded-for']||'').split(',')[0].trim())||req.socket.remoteAddress||'unknown';
  function allowed(key,maximum=rateLimit){
    const now=Date.now();let value=limits.get(key);
    if(!value||value.until<=now){if(limits.size>10000){for(const [id,item] of limits)if(item.until<=now)limits.delete(id);if(limits.size>10000)limits.delete(limits.keys().next().value);}value={count:0,until:now+60000};limits.set(key,value);}
    return ++value.count<=maximum;
  }
  async function body(req,limit=16384){
    if(!(req.headers['content-type']||'').startsWith('application/json'))throw Object.assign(new Error('Send JSON data.'),{status:415});
    let size=0;const parts=[];
    for await(const part of req){size+=part.length;if(size>limit)throw Object.assign(new Error('Request is too large.'),{status:413});parts.push(part);}
    try{return JSON.parse(Buffer.concat(parts).toString());}catch{throw Object.assign(new Error('Invalid JSON request.'),{status:400});}
  }
  async function asset(file){
    const old=cache.get(file);if(old&&Date.now()-old.checkedAt<1000)return old.promise;
    const item={checkedAt:Date.now()};item.promise=(async()=>{const info=await stat(file);if(!info.isFile()||info.size>10*1024*1024)throw new Error('Not found');const previous=old&&await old.promise.catch(()=>null);if(previous?.mtime===info.mtimeMs)return previous;const data=await readFile(file);return{data,mtime:info.mtimeMs,etag:`"${createHash('sha256').update(data).digest('hex')}"`};})()
    if(cache.size>=128&&!old)cache.delete(cache.keys().next().value);cache.set(file,item);
    try{return await item.promise;}catch(error){cache.delete(file);throw error;}
  }
  // Page polls nudge the payout queue (on Vercel nothing else does), but at most every few seconds however many people are watching.
  let lastNudge=0;
  const payouts=()=>{if(Date.now()-lastNudge<PAYOUT_NUDGE_MS)return;lastNudge=Date.now();background(store.processPayouts().catch(()=>{}));};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/healthz'){json(res,200,{status:'ok'});return;}
      if(url.pathname.startsWith('/api/')){
        if(!['GET','HEAD'].includes(req.method)){
          const origin=req.headers.origin;let originHost;try{originHost=new URL(origin).host;}catch{}
          if(!originHost||originHost!==req.headers.host){json(res,403,{error:'This request must come from this website.'});return;}
        }
        if(req.method==='GET'&&url.pathname==='/api/state'){
          const raw=Number(url.searchParams.get('page')||0);if(!Number.isInteger(raw)||raw<0){json(res,400,{error:'Invalid page.'});return;}
          const coin=url.searchParams.get('coin')||'main';if(!COIN_ID.test(coin)){json(res,400,{error:'Invalid coin.'});return;}
          payouts();
          const state=await store.state(raw,coin);const etag=`"${state.revision}-${state.page}-${coin}"`;
          res.setHeader('ETag',etag);res.setHeader('Cache-Control','no-cache');
          if(req.headers['if-none-match']===etag){res.writeHead(304).end();return;}
          json(res,200,state);return;
        }
        if(req.method==='POST'&&url.pathname==='/api/submissions'){
          if(!allowed(clientIp(req))){res.setHeader('Retry-After','60');json(res,429,{error:'Too many submissions. Please wait a minute and try again.'});return;}
          const input=await body(req);if(typeof input.post!=='string'||typeof input.wallet!=='string'){json(res,400,{error:'Provide a post URL and Solana wallet.'});return;}
          const coin=input.coin??'main';if(typeof coin!=='string'||!COIN_ID.test(coin)){json(res,400,{error:'Invalid coin.'});return;}
          const record=await store.submit(input.post,input.wallet,coin);payouts();json(res,201,{record});return;
        }
        if(req.method==='GET'&&url.pathname==='/api/coins'){
          payouts();if(launcher)background(launcher.settlePending().catch(()=>{}));
          json(res,200,{...await store.coins(),launchesEnabled:Boolean(launcher?.enabled)});return;
        }
        // Builds the pump.fun launch transaction; the launcher's wallet signs and sends it.
        if(req.method==='POST'&&url.pathname==='/api/launch'){
          if(!launcher?.enabled){json(res,503,{error:'Coin launches are not switched on yet.'});return;}
          if(!allowed('launch:'+clientIp(req),3)){res.setHeader('Retry-After','60');json(res,429,{error:'Too many launches. Please wait a minute and try again.'});return;}
          json(res,201,await launcher.prepare(await body(req,3*1024*1024)));return;
        }
        if(req.method==='POST'&&url.pathname==='/api/launch/confirm'){
          if(!launcher){json(res,503,{error:'Coin launches are not switched on yet.'});return;}
          const input=await body(req);if(typeof input.mint!=='string'||!COIN_ID.test(input.mint)||input.mint==='main'){json(res,400,{error:'Invalid coin.'});return;}
          const signature=typeof input.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(input.signature)?input.signature:null;
          const coin=await launcher.confirm(input.mint,signature);json(res,200,{mint:coin.id,status:coin.status});return;
        }
        json(res,404,{error:'Not found'});return;
      }
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
      const page=PAGES[url.pathname.replace(/(.)\/$/,'$1')]||(/^\/coin\/[1-9A-HJ-NP-Za-km-z]{32,44}\/?$/.test(url.pathname)&&'/index.html');
      const name=page||decodeURIComponent(url.pathname);
      if(name.includes('\\')||name.includes('\0')||name.split('/').some(part=>part.startsWith('.'))){res.writeHead(404).end();return;}
      const file=path.resolve(root,'.'+name),type=mime[path.extname(file)];
      if(!file.startsWith(root+path.sep)||!type){res.writeHead(404).end();return;}
      const result=await asset(file);res.setHeader('Content-Type',type);res.setHeader('Cache-Control','no-cache');res.setHeader('ETag',result.etag);
      if(req.headers['if-none-match']===result.etag){res.writeHead(304).end();return;}
      res.writeHead(200,{'Content-Length':result.data.length});res.end(req.method==='HEAD'?undefined:result.data);
    }catch(error){
      if(res.headersSent){res.end();return;}
      const status=error.status||(error.code==='ENOENT'?404:500);
      if(status===500)console.error(error);
      json(res,status,{error:status===404?'Not found':status===500?'Something went wrong. Please try again.':error.message});
    }
  });
  server.requestTimeout=40000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  return server;
}
