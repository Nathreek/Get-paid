import { fileURLToPath } from 'node:url';
import { createApp, loadLocalEnv } from './app.mjs';
import { createAppServer } from './http-server.mjs';
loadLocalEnv();
const {store,launcher}=await createApp();
const server=createAppServer({directory:fileURLToPath(new URL('./dist/',import.meta.url)),store,launcher,trustProxy:process.env.TRUST_PROXY==='true'});
const port=Number(process.env.PORT||4173),host=process.env.HOST||'0.0.0.0';
server.listen({port,host,backlog:8192},()=>console.log(`GET PAID is running. Open http://localhost:${port} in your browser.`));
// Keeps payouts moving (and unfinished launches settling) even when nobody has the page open.
const timer=setInterval(()=>{store.processPayouts();launcher?.settlePending().catch(()=>{});},15000);
let closing=false;
function close(){if(closing)return;closing=true;clearInterval(timer);server.close(()=>{store.close();process.exit(0);});setTimeout(()=>server.closeAllConnections(),5000).unref();}
process.on('SIGTERM',close);process.on('SIGINT',close);
