// Synthetic local load: 2,000 simultaneous client workers; not 2,000 real browsers.
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createStore } from '../store.mjs';
import { createAppServer } from '../http-server.mjs';
const file=path.join(tmpdir(),`get-paid-load-${randomUUID()}.sqlite`),store=createStore(file);
const server=createAppServer({directory:fileURLToPath(new URL('../dist/',import.meta.url)),store});server.listen({port:0,host:'127.0.0.1',backlog:8192});await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,concurrency=2000;
const warmed=process.argv.includes('--warm');
const agent=new http.Agent({keepAlive:true,maxSockets:concurrency,maxFreeSockets:concurrency});
const clients=Array.from({length:concurrency},()=>({agent:warmed?new http.Agent({keepAlive:true,maxSockets:1,maxFreeSockets:1}):agent}));
let active=0,peakActive=0,completed=0,bytes=0;const durations=[],failures=[];
const lag=monitorEventLoopDelay({resolution:20});let start;
function request(client,url,method='GET',data){
  const began=performance.now();active++;peakActive=Math.max(peakActive,active);
  return new Promise((resolve,reject)=>{
    const body=data?JSON.stringify(data):undefined;
    const req=http.request(base+url,{agent:client.agent,method,headers:{Origin:base,...(client.cookie?{Cookie:client.cookie}:{}),...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},res=>{
      if(res.headers['set-cookie'])client.cookie=res.headers['set-cookie'][0].split(';')[0];
      const parts=[];res.on('data',part=>{bytes+=part.length;parts.push(part);});res.on('error',reject);res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300){reject(new Error(`HTTP ${res.statusCode} ${url}`));return;}completed++;resolve(Buffer.concat(parts).toString());});
    });req.setTimeout(45000,()=>req.destroy(new Error('Request timeout')));req.on('error',reject);req.end(body);
  }).finally(()=>{active--;durations.push(performance.now()-began);});
}
const warmupErrors=[];
if(warmed){
  for(let i=0;i<concurrency;i+=100)await Promise.all(clients.slice(i,i+100).map(client=>request(client,'/healthz').catch(error=>warmupErrors.push(error.message))));
  completed=0;bytes=0;peakActive=0;durations.length=0;
}
lag.enable();start=performance.now();
await Promise.all(clients.map(async(client,i)=>{
  try{
    await request(client,'/');await request(client,'/app.js');await request(client,'/api/state');
    await request(client,'/api/submissions','POST',{handle:`load${i}`,post:`https://x.com/load${i}/status/${i+1}`});
    const state=JSON.parse(await request(client,'/api/state'));
    if(state.records.length>25)throw new Error('Unbounded page');
    await request(client,'/api/state?page=1');
  }catch(error){failures.push(error.message);}
}));
const elapsed=performance.now()-start;lag.disable();durations.sort((a,b)=>a-b);
const totalRecords=store.state('audit').total;
const result={timestamp:new Date().toISOString(),mode:warmed?'Established connections, opened in cohorts of 100':'Cold simultaneous connection burst',warmupFailed:warmupErrors.length,scope:'Local Windows loopback; load driver and server share one Node process. Real SQLite WAL database on disk.',clientWorkers:concurrency,peakConcurrentRequests:peakActive,expectedRequests:12000,completedRequests:completed,failedClients:failures.length,persistedSubmissions:totalRecords,elapsedMs:Math.round(elapsed),requestsPerSecond:Math.round(completed/(elapsed/1000)),p95Ms:Math.round(durations[Math.floor(durations.length*.95)]),p99Ms:Math.round(durations[Math.floor(durations.length*.99)]),maxEventLoopDelayMs:Math.round(lag.max/1e6),combinedProcessMemoryMB:Math.round(process.memoryUsage().rss/1024/1024),bytes,errors:[...new Set([...warmupErrors,...failures])].slice(0,10),limits:['Short synthetic burst, not sustained production traffic or 2,000 actual browser renders.','Hosted CPU, disk, network, TLS, CDN, provider limits, abuse and outages remain untested.','No X verification or payment provider is connected.']};
console.log(JSON.stringify(result,null,2));if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2));
agent.destroy();for(const client of clients)client.agent.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();
for(const suffix of ['','-wal','-shm'])await unlink(file+suffix).catch(()=>{});
if(failures.length||totalRecords!==concurrency||completed!==12000)process.exitCode=1;
