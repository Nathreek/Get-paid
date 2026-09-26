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
// Collects the site coin's creator fees into the treasury every AUTO_CLAIM_SECONDS (3–4 s by default; 0 turns it off).
const claimEvery=Number(process.env.AUTO_CLAIM_SECONDS??3.5)*1000;let claimTimer;
const autoClaim=()=>{claimTimer=setTimeout(async()=>{await store.autoClaim();autoClaim();},claimEvery*(.85+Math.random()*.3));};
if(claimEvery>0)autoClaim();
let closing=false;
function close(){if(closing)return;closing=true;clearInterval(timer);clearTimeout(claimTimer);server.close(()=>{store.close();process.exit(0);});setTimeout(()=>server.closeAllConnections(),5000).unref();}
process.on('SIGTERM',close);process.on('SIGINT',close);
