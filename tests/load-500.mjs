import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFile,unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const database=path.join(tmpdir(),`get-paid-500-${randomUUID()}.sqlite`);
const worker=fork(fileURLToPath(new URL('./load-worker.mjs',import.meta.url)),[database],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
worker.stderr.on('data',chunk=>process.stderr.write(chunk));const [{port}]=await once(worker,'message');
const base=`http://127.0.0.1:${port}`,clients=500,agent=new http.Agent({keepAlive:true,maxSockets:clients,maxFreeSockets:clients});
let active=0,peak=0,completed=0,bytes=0;const errors=[],times=[];
async function request(client,url,method='GET',payload){
  const started=performance.now();active++;peak=Math.max(peak,active);
  try{return await new Promise((resolve,reject)=>{
    const body=payload?JSON.stringify(payload):undefined;
    const req=http.request(base+url,{method,agent,headers:{Origin:base,...(client.cookie?{Cookie:client.cookie}:{}),...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},res=>{
      if(res.headers['set-cookie'])client.cookie=res.headers['set-cookie'][0].split(';')[0];const parts=[];
      res.on('data',part=>{bytes+=part.length;parts.push(part);});res.on('error',reject);
      res.on('end',()=>{if(res.statusCode!==200&&res.statusCode!==201){reject(new Error(`HTTP ${res.statusCode} ${url}`));return;}completed++;resolve(Buffer.concat(parts).toString());});
    });req.setTimeout(30000,()=>req.destroy(new Error('timeout')));req.on('error',reject);req.end(body);
  });}finally{active--;times.push(performance.now()-started);}
}
const started=performance.now();
await Promise.all(Array.from({length:clients},async(_,i)=>{const client={};try{
  await request(client,'/');await request(client,'/styles.css');await request(client,'/client.js');await request(client,'/api/state');
  await request(client,'/api/submissions','POST',{handle:`visitor${i}`,post:`https://x.com/visitor${i}/status/${i+1}`});
  for(let j=0;j<4;j++){const state=JSON.parse(await request(client,`/api/state?page=${j%2}`));if(state.records.length>25)throw new Error('Page exceeded 25 records');}
}catch(error){errors.push(error.message);}}));
const elapsed=performance.now()-started;times.sort((a,b)=>a-b);worker.send('metrics');const [{metrics}]=await once(worker,'message');
const result={timestamp:new Date().toISOString(),scope:'500 simultaneous virtual visitors opening fresh connections; separate server and load-generator processes on local Windows loopback; real on-disk SQLite WAL database.',clients,peakConcurrentRequests:peak,expectedRequests:4500,completedRequests:completed,failedClients:errors.length,persistedSubmissions:metrics.total,elapsedMs:Math.round(elapsed),requestsPerSecond:Math.round(completed/(elapsed/1000)),p95Ms:Math.round(times[Math.floor(times.length*.95)]),p99Ms:Math.round(times[Math.floor(times.length*.99)]),serverMemoryMB:metrics.rssMB,serverMaxEventLoopDelayMs:metrics.maxEventLoopDelayMs,bytes,errors:[...new Set(errors)],limitations:['Synthetic short burst, not a guarantee of uptime or 500 real browser sessions.','Hosted network, TLS, hosting limits, sustained traffic, abuse protection and provider outages are not covered.','No real X verification, purchase or payout was performed.']};
console.log(JSON.stringify(result,null,2));if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2));
agent.destroy();worker.send('close');await once(worker,'exit');for(const suffix of ['','-wal','-shm'])await unlink(database+suffix).catch(()=>{});
if(errors.length||completed!==4500||metrics.total!==clients)process.exitCode=1;
