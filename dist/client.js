import { normalizeHandle, normalizePost, readRecords } from './model.js';
import { config } from './config.js';
const $=selector=>document.querySelector(selector);
let snapshot={records:[],total:0,page:0,pages:1,pageSize:25},page=0,etag='',pollTimer,tickTimer,toastTimer;
let syncing=false,pendingRefresh=false,submitting=false,clockOffset=0,failures=0,renderKey='',lastFeatured='',acknowledged=new Set();
const now=()=>Date.now()+clockOffset;
function element(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),5000);}
function connection(message){$('#connection-status').textContent=message;$('#connection-status').hidden=!message;}
async function request(url,options={}){
  const response=await fetch(url,{credentials:'same-origin',signal:AbortSignal.timeout(15000),...options});
  if(response.status===304)return{response,data:null};
  const data=await response.json();if(!response.ok){const error=new Error(data.error||'Could not complete the request. Please try again.');error.status=response.status;throw error;}
  return{response,data};
}
const send=(url,data,method='POST')=>request(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
function status(record){return now()<record.revealAt?'queued':record.sentAt?'sent':'pending';}
function render(force=false){
  const key=JSON.stringify([snapshot.page,snapshot.total,snapshot.records.map(record=>[record.id,status(record),record.canDelete])]);
  $('#total-badge').textContent=snapshot.total;
  if(!force&&key===renderKey){updateTimers();return;}renderKey=key;
  const active=document.activeElement?.getAttribute('aria-label');
  const list=$('#reveal-list');list.replaceChildren();$('#empty-state').hidden=snapshot.total>0;
  $('#list-pagination').hidden=snapshot.pages<=1;$('#previous-page').disabled=snapshot.page===0;$('#next-page').disabled=snapshot.page>=snapshot.pages-1;
  $('#page-summary').textContent=`${snapshot.page*snapshot.pageSize+1}–${snapshot.page*snapshot.pageSize+snapshot.records.length} of ${snapshot.total}`;
  for(const record of snapshot.records){
    const state=status(record),visible=state!=='queued',row=element('article','reveal-row');row.dataset.id=record.id;row.dataset.state=state;
    const avatar=element('span',`avatar${visible?'':' pending'}`,visible?record.displayName.split(' ').map(word=>word[0]).slice(0,2).join('').toUpperCase():'◷');avatar.setAttribute('aria-hidden','true');
    const info=element('div','profile-info');info.append(element('span','profile-name',visible?record.displayName:'A name is on its way…'));
    const sub=element('div','profile-subline');sub.append(element('span','',`@${record.handle}`));
    if(visible){const link=element('a','','View post ↗');link.href=record.post;link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label',`View post from @${record.handle} (opens in a new tab)`);sub.append(link);}
    else sub.append(element('span','local-badge','Queued'));info.append(sub);
    if(!visible){const track=element('div','progress-track');track.setAttribute('role','progressbar');track.setAttribute('aria-label',`Queue progress for @${record.handle}`);track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.append(element('div','progress-fill'));info.append(track);}
    const end=element('div','row-end'),badge=element('span',`reveal-state status-${state}`,visible?(state==='sent'?'Sent':'Pending'):'');
    if(visible)badge.title=state==='sent'?'Shown in the top box':'Waiting to appear in the top box';end.append(badge);
    if(record.canDelete){const remove=element('button','icon-button','×');remove.type='button';remove.setAttribute('aria-label',`Remove @${record.handle}`);remove.addEventListener('click',async()=>{remove.disabled=true;try{await send(`/api/submissions/${record.id}`,{},'DELETE');etag='';await refresh(true);toast(`@${record.handle} removed.`);}catch(error){remove.disabled=false;toast(error.message);}});end.append(remove);}
    row.append(avatar,info,end);list.append(row);
  }
  updateTimers();clearInterval(tickTimer);
  if(snapshot.records.some(record=>now()<record.revealAt))tickTimer=setInterval(()=>render(),250);
  if(active)[...list.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')===active)?.focus();
}
function updateTimers(){
  const map=new Map(snapshot.records.map(record=>[record.id,record]));
  for(const row of $('#reveal-list').children){if(row.dataset.state!=='queued')continue;const record=map.get(row.dataset.id);if(!record)continue;
    row.querySelector('.reveal-state').textContent=`${Math.max(0,Math.ceil((record.revealAt-now())/1000))}s`;
    const progress=Math.min(100,Math.max(0,(now()-record.createdAt)/(record.revealAt-record.createdAt)*100));row.querySelector('.progress-fill').style.width=`${progress}%`;row.querySelector('.progress-track').setAttribute('aria-valuenow',String(Math.round(progress)));
  }
}
async function feature(item){
  if(!item)return;
  if(lastFeatured!==item.name){$('#featured-name').textContent=item.name;$('#featured-avatar').textContent=item.name.split(' ').map(word=>word[0]).slice(0,2).join('');lastFeatured=item.name;}
  if(item.recordId&&!document.hidden&&!acknowledged.has(item.recordId)){
    const id=item.recordId;acknowledged.add(id);
    // Wait for the rendered name to reach the screen before recording its Sent status.
    await new Promise(resolve=>{const timeout=setTimeout(resolve,1000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve();}));});
    if(document.hidden||lastFeatured!==item.name){acknowledged.delete(id);return;}
    try{const {data}=await send('/api/spotlight/seen',{id});if(data.recorded){const record=snapshot.records.find(row=>row.id===id);if(record){record.sentAt=now();render();}etag='';}else acknowledged.delete(id);}catch{acknowledged.delete(id);}
  }
}
function schedule(){clearTimeout(pollTimer);if(!document.hidden)pollTimer=setTimeout(()=>refresh(),failures?Math.min(30000,5000*failures):4000+Math.random()*2000);}
async function refresh(force=false){
  if(syncing){if(force)pendingRefresh=true;return;}syncing=true;const requestedPage=page;
  try{const {response,data}=await request(`/api/state?page=${requestedPage}`,{headers:!force&&etag?{'If-None-Match':etag}:{}});if(page!==requestedPage){pendingRefresh=true;return;}if(data){clockOffset=data.serverNow-Date.now();snapshot=data;page=data.page;etag=response.headers.get('etag')||'';render();void feature(data.spotlight);}else{render();void feature(snapshot.spotlight);}failures=0;connection('');}
  catch(error){failures++;connection('Connection interrupted. Retrying automatically. Your saved submissions are safe.');}
  finally{syncing=false;if(pendingRefresh){pendingRefresh=false;void refresh(true);}else schedule();}
}
async function submit(postValue,handleValue){
  if(submitting)throw new Error('Your previous submission is still being saved. Please wait a moment.');
  submitting=true;
  try{const post=normalizePost(postValue),handle=normalizeHandle(handleValue);const {data}=await send('/api/submissions',{post,handle});page=0;etag='';await refresh(true);toast('You’re in the queue.');return{id:data.record.id,handle,status:'queued',revealAt:data.record.revealAt};}
  finally{submitting=false;}
}
$('#submission-form').addEventListener('submit',async event=>{
  event.preventDefault();$('#form-error').textContent='';let firstInvalid;
  for(const [id,validator,errorId] of [['post-url',normalizePost,'post-error'],['x-handle',normalizeHandle,'handle-error']]){const input=$(`#${id}`);$(`#${errorId}`).textContent='';input.removeAttribute('aria-invalid');try{validator(input.value);}catch(error){$(`#${errorId}`).textContent=error.message;input.setAttribute('aria-invalid','true');firstInvalid ||=input;}}
  if(firstInvalid){firstInvalid.focus();return;}
  const button=$('#submit-button');button.disabled=true;button.textContent='Adding to queue…';
  try{await submit($('#post-url').value,$('#x-handle').value);event.target.reset();}catch(error){$('#form-error').textContent=error.message||'Could not save. Please try again.';}
  finally{button.disabled=false;button.replaceChildren(document.createTextNode('Add to the queue '),element('span','','↗'));}
});
for(const [id,error] of [['post-url','post-error'],['x-handle','handle-error']])$(`#${id}`).addEventListener('input',()=>{$(`#${id}`).removeAttribute('aria-invalid');$(`#${error}`).textContent='';$('#form-error').textContent='';});
$('#previous-page').addEventListener('click',()=>{page=Math.max(0,page-1);etag='';refresh(true);});
$('#next-page').addEventListener('click',()=>{page++;etag='';refresh(true);});
if(config.coinAddress){$('#coin-address').textContent=config.coinAddress;$('#contract-tag').hidden=true;$('#copy-address').hidden=false;$('#buy-coin-address').textContent=config.coinAddress;$('#buy-ca-status').hidden=true;$('#buy-copy-address').hidden=false;}
async function copyAddress(){try{await navigator.clipboard.writeText(config.coinAddress);toast('Coin address copied.');}catch{toast('Select the address to copy it.');}}
$('#copy-address').addEventListener('click',copyAddress);$('#buy-copy-address').addEventListener('click',copyAddress);
$('#copy-treasury').addEventListener('click',async()=>{
  const address=$('#treasury-address');
  try{await navigator.clipboard.writeText(address.textContent.trim());toast('Treasury wallet copied.');}
  catch{const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(address);selection.removeAllRanges();selection.addRange(range);toast('Wallet address selected. Copy it to your clipboard.');}
});
$('#buy').addEventListener('click',()=>$('#buy-dialog').showModal());
$('#buy-dialog').addEventListener('click',event=>{if(event.target===$('#buy-dialog')){const r=event.target.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)event.target.close();}});
document.addEventListener('visibilitychange',()=>{clearTimeout(pollTimer);if(!document.hidden){render();refresh(true);}});
window.addEventListener('online',()=>refresh(true));
async function migrateLocalEntries(){
  try{
    const entries=readRecords(localStorage),done=new Set(JSON.parse(localStorage.getItem('gp.imported.v1')||'[]'));
    const remaining=entries.filter(record=>!done.has(record.id));
    for(let start=0;start<remaining.length;start+=100){
      const {data}=await send('/api/import',{entries:remaining.slice(start,start+100).map(({id,post,handle})=>({id,post,handle}))});
      for(const result of data.results)if(result.imported)done.add(result.legacyId);
      localStorage.setItem('gp.imported.v1',JSON.stringify([...done]));
    }
    // Keep original browser storage untouched as a backup.
  }catch{toast('Some older entries could not be imported yet. The original browser copy has been kept.');}
}
if(navigator.modelContext?.registerTool){try{navigator.modelContext.registerTool({name:'submit_x_post',description:'Submit an X post and handle to the shared queue. The name appears in the list after queueing and is eligible for the top box one minute later.',inputSchema:{type:'object',properties:{postUrl:{type:'string'},handle:{type:'string'}},required:['postUrl','handle'],additionalProperties:false},execute:async({postUrl,handle})=>({content:[{type:'text',text:JSON.stringify(await submit(postUrl,handle))}]})});}catch{}}
await refresh(true);await migrateLocalEntries();etag='';await refresh(true);
