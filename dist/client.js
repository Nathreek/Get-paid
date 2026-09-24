import { normalizePost, normalizeWallet, shortWallet, formatUsd } from './model.js';
import { config } from './config.js';
const $=selector=>document.querySelector(selector);
let snapshot={records:[],total:0,page:0,pages:1,pageSize:25},page=0,etag='',pollTimer,toastTimer;
let syncing=false,pendingRefresh=false,submitting=false,failures=0,renderKey='';
function element(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
function link(text,href,label){const node=element('a','',text);node.href=href;node.target='_blank';node.rel='noopener noreferrer';node.setAttribute('aria-label',label);return node;}
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),5000);}
function connection(message){$('#connection-status').textContent=message;$('#connection-status').hidden=!message;}
async function request(url,options={}){
  const response=await fetch(url,{credentials:'same-origin',signal:AbortSignal.timeout(45000),...options});
  if(response.status===304)return{response,data:null};
  const data=await response.json();if(!response.ok){const error=new Error(data.error||'Could not complete the request. Please try again.');error.status=response.status;throw error;}
  return{response,data};
}
// Solscan links follow the server's network, so devnet test payments open the right page.
const solscan=path=>`https://solscan.io/${path}${snapshot.cluster==='devnet'?'?cluster=devnet':''}`;
const badges={queued:['Approved · queued','Approved. Waiting for its automatic payout.'],sending:['Sending…','The SOL transfer is being confirmed on-chain.'],failed:['Not paid','This entry could not be paid.']};
function render(){
  const key=JSON.stringify([snapshot.page,snapshot.total,snapshot.records.map(record=>[record.id,record.status,record.amountCents])]);
  $('#total-badge').textContent=snapshot.total;
  $('#paid-summary').textContent=snapshot.paidCount?`${snapshot.paidCount} paid · ${formatUsd(snapshot.paidCents)} total.`:'';
  if(key===renderKey)return;renderKey=key;
  const list=$('#reveal-list');list.replaceChildren();$('#empty-state').hidden=snapshot.total>0;
  $('#list-pagination').hidden=snapshot.pages<=1;$('#previous-page').disabled=snapshot.page===0;$('#next-page').disabled=snapshot.page>=snapshot.pages-1;
  $('#page-summary').textContent=`${snapshot.page*snapshot.pageSize+1}–${snapshot.page*snapshot.pageSize+snapshot.records.length} of ${snapshot.total}`;
  for(const record of snapshot.records){
    const row=element('article','reveal-row');row.dataset.id=record.id;row.dataset.state=record.status;
    const avatar=element('span','avatar',record.wallet.slice(0,2));avatar.setAttribute('aria-hidden','true');
    const info=element('div','profile-info'),name=link(shortWallet(record.wallet),solscan(`account/${record.wallet}`),`View wallet ${record.wallet} on Solscan (opens in a new tab)`);name.className='profile-name';name.title=record.wallet;info.append(name);
    const sub=element('div','profile-subline');sub.append(element('span','',`@${record.author}`),link('View post ↗',record.post,`View post from @${record.author} (opens in a new tab)`));
    if(record.status==='sent')sub.append(link('View on Solscan ↗',solscan(`tx/${record.signature}`),`View payment transaction for ${shortWallet(record.wallet)} (opens in a new tab)`));
    info.append(sub);
    const end=element('div','row-end'),[text,title]=record.status==='sent'?[`Sent ${formatUsd(record.amountCents)}`,'Paid in SOL']:badges[record.status]||[record.status,''];
    const badge=element('span',`reveal-state status-${record.status}`,text);badge.title=title;end.append(badge);
    row.append(avatar,info,end);list.append(row);
  }
}
function feature(payout){
  const amount=payout?formatUsd(payout.amountCents):'';
  $('#featured-amount').textContent=amount;$('#featured-amount').hidden=!amount;$('#featured-label').textContent=amount?'sent to':'Next up';
  const name=payout?shortWallet(payout.wallet):'Your wallet could be next';
  $('#featured-name').textContent=name;$('#featured-avatar').textContent=payout?payout.wallet.slice(0,2):'◎';
}
function schedule(){clearTimeout(pollTimer);if(!document.hidden)pollTimer=setTimeout(()=>refresh(),failures?Math.min(30000,5000*failures):4000+Math.random()*2000);}
async function refresh(force=false){
  if(syncing){if(force)pendingRefresh=true;return;}syncing=true;const requestedPage=page;
  try{const {response,data}=await request(`/api/state?page=${requestedPage}`,{headers:!force&&etag?{'If-None-Match':etag}:{}});if(page!==requestedPage){pendingRefresh=true;return;}if(data){snapshot=data;page=data.page;etag=response.headers.get('etag')||'';render();feature(data.latestPayout);}failures=0;connection('');}
  catch{failures++;connection('Connection interrupted. Retrying automatically.');}
  finally{syncing=false;if(pendingRefresh){pendingRefresh=false;void refresh(true);}else schedule();}
}
async function submit(postValue,walletValue){
  if(submitting)throw new Error('Your previous submission is still being checked. Please wait a moment.');
  submitting=true;
  try{const post=normalizePost(postValue),wallet=normalizeWallet(walletValue);const {data}=await request('/api/submissions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({post,wallet})});page=0;etag='';await refresh(true);toast('Approved! Your SOL payout is queued.');return data.record;}
  finally{submitting=false;}
}
$('#submission-form').addEventListener('submit',async event=>{
  event.preventDefault();$('#form-error').textContent='';let firstInvalid;
  for(const [id,validator,errorId] of [['post-url',normalizePost,'post-error'],['wallet',normalizeWallet,'wallet-error']]){const input=$(`#${id}`);$(`#${errorId}`).textContent='';input.removeAttribute('aria-invalid');try{validator(input.value);}catch(error){$(`#${errorId}`).textContent=error.message;input.setAttribute('aria-invalid','true');firstInvalid ||=input;}}
  if(firstInvalid){firstInvalid.focus();return;}
  const button=$('#submit-button');button.disabled=true;button.textContent='Checking your post…';
  try{await submit($('#post-url').value,$('#wallet').value);event.target.reset();}catch(error){$('#form-error').textContent=error.message||'Could not submit. Please try again.';}
  finally{button.disabled=false;button.replaceChildren(document.createTextNode('Check my post '),element('span','','↗'));}
});
for(const [id,error] of [['post-url','post-error'],['wallet','wallet-error']])$(`#${id}`).addEventListener('input',()=>{$(`#${id}`).removeAttribute('aria-invalid');$(`#${error}`).textContent='';$('#form-error').textContent='';});
$('#previous-page').addEventListener('click',()=>{page=Math.max(0,page-1);etag='';refresh(true);});
$('#next-page').addEventListener('click',()=>{page++;etag='';refresh(true);});
if(config.ticker)for(const node of document.querySelectorAll('.ticker'))node.textContent=`$${config.ticker}`;
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
document.addEventListener('visibilitychange',()=>{clearTimeout(pollTimer);if(!document.hidden)refresh(true);});
window.addEventListener('online',()=>refresh(true));
if(navigator.modelContext?.registerTool){try{navigator.modelContext.registerTool({name:'submit_x_post',description:'Submit an X post and Solana wallet. The post is checked for the coin ticker and positive promotion; approved posts are paid in SOL automatically.',inputSchema:{type:'object',properties:{postUrl:{type:'string'},wallet:{type:'string'}},required:['postUrl','wallet'],additionalProperties:false},execute:async({postUrl,wallet})=>({content:[{type:'text',text:JSON.stringify(await submit(postUrl,wallet))}]})});}catch{}}
await refresh(true);
