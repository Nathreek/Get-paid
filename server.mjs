import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStore } from './store.mjs';
import { createAppServer } from './http-server.mjs';
const database=path.resolve(process.env.DB_PATH||fileURLToPath(new URL('./data/submissions.sqlite',import.meta.url)));
await mkdir(path.dirname(database),{recursive:true});
const store=createStore(database);
const server=createAppServer({directory:fileURLToPath(new URL('./dist/',import.meta.url)),store,secureCookies:process.env.SECURE_COOKIES==='true'});
const port=Number(process.env.PORT||4173),host=process.env.HOST||'127.0.0.1';
server.listen({port,host,backlog:8192},()=>console.log(`GET PAID is running at http://${host}:${port}`));
let closing=false;
function close(){if(closing)return;closing=true;server.close(()=>{store.close();process.exit(0);});setTimeout(()=>server.closeAllConnections(),5000).unref();}
process.on('SIGTERM',close);process.on('SIGINT',close);
