import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createStore } from '../store.mjs';
import { createAppServer } from '../http-server.mjs';
const store=createStore(process.argv[2]);
const server=createAppServer({directory:fileURLToPath(new URL('../dist/',import.meta.url)),store});
const lag=monitorEventLoopDelay({resolution:20});lag.enable();
server.listen({port:0,host:'127.0.0.1',backlog:8192},()=>process.send({port:server.address().port}));
process.on('message',message=>{
  if(message==='metrics')process.send({metrics:{total:store.state('audit').total,rssMB:Math.round(process.memoryUsage().rss/1024/1024),maxEventLoopDelayMs:Math.round(lag.max/1e6)}});
  if(message==='close'){server.closeAllConnections();server.close(()=>{store.close();process.exit(0);});}
});
