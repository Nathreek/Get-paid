import { normalizePost, normalizeWallet, shortWallet, formatUsd } from './model.js';
import { config } from './config.js';
import { examples } from './examples.js';
const $=selector=>document.querySelector(selector);
let snapshot={records:[],total:0,page:0,pages:1,pageSize:25},page=0,etag='',pollTimer,toastTimer;
let syncing=false,pendingRefresh=false,submitting=false,failures=0,renderKey='';
// On /coin/<mint address> the page runs that coin's campaign; its details come from the server.
const coinId=location.pathname.match(/^\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/)?.[1]||'main';
let ticker=config.ticker,coinAddress=config.coinAddress,buyUrl='',coinReady=false;
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
const badges={queued:['Queued','Approved. Waiting for its automatic payout.'],sending:['Sending…','The SOL transfer is being confirmed on-chain.'],failed:['Not paid','This entry could not be paid.']};
const initials=name=>[...name.replace(/[^\p{L}\p{N} ]/gu,'').trim()].slice(0,1).join('').toUpperCase()||'◎';
function ago(time){const s=Math.max(0,(Date.now()-time)/1000);return s<60?'now':s<3600?`${Math.floor(s/60)}m`:s<86400?`${Math.floor(s/3600)}h`:`${Math.floor(s/86400)}d`;}
const sol=lamports=>`${(lamports/1e9).toFixed(lamports<1e9?4:2)} SOL`;
// Profile picture from X, falling back to the name's first letter if it is missing or fails to load.
function pfp(record,cls='pfp'){
  const holder=element('span',cls);holder.setAttribute('aria-hidden','true');
  const fallback=()=>holder.replaceChildren(document.createTextNode(initials(record.name||record.author)));
  if(record.avatar){const img=element('img');img.src=record.avatar;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.onerror=fallback;holder.append(img);}else fallback();
  return holder;
}
// Tweet text with the coin's cashtag highlighted; built from text nodes only.
function tweetText(text){
  const node=element('p','tweet-text');if(!text)return node;
  const pattern=ticker?new RegExp(`(\$${ticker})(?![A-Za-z0-9_])`,'gi'):null;
  for(const part of pattern?text.split(pattern):[text])node.append(pattern&&part.toUpperCase()===`$${ticker}`.toUpperCase()?element('strong','cashtag',part):document.createTextNode(part));
  return node;
}
function stats(){
  $('#stat-paid').textContent=formatUsd(snapshot.paidCents||0);$('#stat-sol').textContent=snapshot.paidLamports?sol(snapshot.paidLamports):'paid in SOL';
  $('#stat-posts').textContent=snapshot.paidCount||0;$('#stat-wallets').textContent=snapshot.walletsPaid||0;$('#stat-queue').textContent=snapshot.queued||0;
  if(coinId!=='main'&&typeof snapshot.feePoolLamports==='number')$('#coin-pool').textContent=`Fee pool: ${sol(snapshot.feePoolLamports)}`;
}
function render(){
  const key=JSON.stringify([snapshot.page,snapshot.total,Math.floor(Date.now()/60000),snapshot.records.map(record=>[record.id,record.status,record.amountCents])]);
  $('#total-badge').textContent=snapshot.total;stats();
  if(key===renderKey)return;renderKey=key;
  const list=$('#reveal-list');list.replaceChildren();$('#empty-state').hidden=snapshot.total>0;
  $('#list-pagination').hidden=snapshot.pages<=1;$('#previous-page').disabled=snapshot.page===0;$('#next-page').disabled=snapshot.page>=snapshot.pages-1;
  $('#page-summary').textContent=`${snapshot.page*snapshot.pageSize+1}–${snapshot.page*snapshot.pageSize+snapshot.records.length} of ${snapshot.total}`;
  for(const record of snapshot.records){
    const card=element('article','payout-card');card.dataset.id=record.id;card.dataset.state=record.status;
    const head=element('div','payout-head'),avatar=pfp(record);avatar.append(element('span','x-badge','𝕏'));
    const who=element('div','who'),name=link(record.name||record.author,record.post,`View post from @${record.author} (opens in a new tab)`);name.className='who-name';
    who.append(name,element('span','who-meta',`@${record.author} · ${ago(record.paidAt||record.createdAt)}`));
    const amount=element('div','payout-amount');
    if(record.status==='sent'){amount.append(...record.lamports?[element('strong','',`+${sol(record.lamports)}`),element('small','',formatUsd(record.amountCents))]:[element('strong','',formatUsd(record.amountCents)),element('small','','in SOL')]);amount.title='Paid in SOL';}
    else{const [text,title]=badges[record.status]||[record.status,''];const badge=element('span',`reveal-state status-${record.status}`,text);badge.title=title;amount.append(badge);}
    head.append(avatar,who,amount);
    const foot=element('div','payout-foot'),wallet=link(`◎ ${shortWallet(record.wallet)}`,solscan(`account/${record.wallet}`),`View wallet ${record.wallet} on Solscan (opens in a new tab)`);wallet.title=record.wallet;
    foot.append(wallet,link('View post ↗',record.post,`View post from @${record.author} (opens in a new tab)`));
    if(record.status==='sent')foot.append(link('Solscan ↗',solscan(`tx/${record.signature}`),`View payment transaction to ${shortWallet(record.wallet)} (opens in a new tab)`));
    card.append(head,tweetText(record.text),foot);list.append(card);
  }
}
function feature(payout){
  const amount=payout?formatUsd(payout.amountCents):'';
  $('#featured-amount').textContent=amount;$('#featured-amount').hidden=!amount;$('#featured-label').textContent=amount?'sent to':'Next up';
  $('#featured-name').textContent=payout?`@${payout.author}`:'You could be next';
  const avatar=payout?pfp(payout,'tiny-avatar'):element('span','tiny-avatar','◎');avatar.id='featured-avatar';avatar.setAttribute('aria-hidden','true');$('#featured-avatar').replaceWith(avatar);
}
setInterval(()=>{if(!document.hidden)render();},30000);
// Example posts: two rows drifting in opposite directions. Each row holds its cards twice so the loop is seamless.
const icon=path=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
const icons={reply:icon('M4 12a8 8 0 0 1 8-8h0a8 8 0 0 1 0 16H6l-2 2z'),repost:icon('M7 7h10v4M17 17H7v-4M14 4l3 3-3 3M10 20l-3-3 3-3'),like:icon('M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'),views:icon('M5 20V12M10 20V6M15 20v-9M20 20V9')};
function exampleCard(example){
  const card=element('li','tweet-mock'),head=element('div','tweet-head'),who=element('div','who');
  who.append(element('strong','',example.name),element('span','',`@${example.handle} · ${example.time}`));
  head.append(element('span','pfp emoji',example.pfp),who,element('span','x-logo','𝕏'));
  const cashtag=ticker?`$${ticker}`:'$TICKER',text=element('p','example-text');
  example.text.split('{T}').forEach((part,i)=>{if(i)text.append(element('strong','cashtag',cashtag));text.append(document.createTextNode(part));});
  const actions=element('div','tweet-actions');
  for(const [name,count] of [['reply',''],['repost',example.reposts],['like',example.likes],['views',`${(example.likes*23/1000).toFixed(1)}K`]]){const item=element('span');item.innerHTML=icons[name];item.append(document.createTextNode(count));actions.append(item);}
  card.append(head,text,actions,element('p','approved-chip','✓ Approved'));
  return card;
}
function buildMarquee(){
  const marquee=$('#example-marquee');if(!marquee)return;
  const half=Math.ceil(examples.length/2);
  [examples.slice(0,half),examples.slice(half)].forEach((row,index)=>{
    const track=element('ul',`marquee-track${index?' reverse':''}`);
    for(const copy of [0,1])for(const example of row){const card=exampleCard(example);if(copy)card.setAttribute('aria-hidden','true');track.append(card);}
    marquee.append(track);
  });
}
function schedule(){clearTimeout(pollTimer);if(!document.hidden)pollTimer=setTimeout(()=>refresh(),failures?Math.min(30000,5000*failures):4000+Math.random()*2000);}
async function refresh(force=false){
  if(syncing){if(force)pendingRefresh=true;return;}syncing=true;const requestedPage=page;
  try{const {response,data}=await request(`/api/state?page=${requestedPage}&coin=${coinId}`,{headers:!force&&etag?{'If-None-Match':etag}:{}});if(page!==requestedPage){pendingRefresh=true;return;}if(data){if(!coinReady)applyCoin(data.coin);snapshot=data;page=data.page;etag=response.headers.get('etag')||'';render();feature(data.latestPayout);}failures=0;connection('');}
  catch(error){failures++;connection(error.status===404?'This coin is not on GET-PAID. If it was launched a moment ago, it appears within a minute.':'Connection interrupted. Retrying automatically.');}
  finally{syncing=false;if(pendingRefresh){pendingRefresh=false;void refresh(true);}else schedule();}
}
async function submit(postValue,walletValue){
  if(submitting)throw new Error('Your previous submission is still being checked. Please wait a moment.');
  submitting=true;
  try{const post=normalizePost(postValue),wallet=normalizeWallet(walletValue);const {data}=await request('/api/submissions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({post,wallet,coin:coinId})});page=0;etag='';await refresh(true);toast('Approved! Your SOL payout is queued.');return data.record;}
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
// Fills the page with the coin's ticker, address and payout wallet. The main page uses config.js; coin pages wait for the server.
function applyCoin(coin){
  coinReady=true;
  if(coin?.launched){
    ticker=coin.ticker;coinAddress=coin.coinAddress;buyUrl=`https://pump.fun/coin/${coin.coinAddress}`;
    document.title=`$${coin.ticker} · Shill it. Get paid in SOL. · GET-PAID`;
    $('#headline').firstChild.textContent=`Shill $${coin.ticker}.`;
    $('#treasury-label').textContent=`$${coin.ticker} payout wallet`;$('#treasury-address').textContent=coin.payoutWallet;
    if(coin.image){$('#coin-image').src=coin.image;$('#coin-image').referrerPolicy='no-referrer';}else $('#coin-image').hidden=true;
    $('#coin-name').textContent=coin.name;
    const meta=$('#coin-meta');meta.replaceChildren(document.createTextNode(`$${coin.ticker} · creator fees pay its shillers · `),element('span','','')); meta.lastChild.id='coin-pool';
    const links=$('#coin-links');links.replaceChildren(link('pump.fun ↗',buyUrl,`$${coin.ticker} on pump.fun (opens in a new tab)`));
    for(const [label,href] of [['𝕏',coin.twitter],['Telegram',coin.telegram],['Website',coin.website]])if(href)links.append(link(label,href,`$${coin.ticker} ${label} (opens in a new tab)`));
    $('#coin-banner').hidden=false;$('#announce').hidden=true;
  }
  if(ticker)for(const node of document.querySelectorAll('.ticker'))node.textContent=`$${ticker}`;
  if(coinAddress){$('#coin-address').textContent=coinAddress;$('#contract-tag').hidden=true;$('#copy-address').hidden=false;$('#buy-coin-address').textContent=coinAddress;$('#buy-ca-status').hidden=true;$('#buy-copy-address').hidden=false;}
  buildMarquee();
}
if(coinId==='main')applyCoin(null);
async function copyAddress(){try{await navigator.clipboard.writeText(coinAddress);toast('Coin address copied.');}catch{toast('Select the address to copy it.');}}
$('#copy-address').addEventListener('click',copyAddress);$('#buy-copy-address').addEventListener('click',copyAddress);
$('#copy-treasury').addEventListener('click',async()=>{
  const address=$('#treasury-address');
  try{await navigator.clipboard.writeText(address.textContent.trim());toast('Treasury wallet copied.');}
  catch{const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(address);selection.removeAllRanges();selection.addRange(range);toast('Wallet address selected. Copy it to your clipboard.');}
});
$('#buy').addEventListener('click',()=>buyUrl?window.open(buyUrl,'_blank','noopener,noreferrer'):$('#buy-dialog').showModal());
$('#buy-dialog').addEventListener('click',event=>{if(event.target===$('#buy-dialog')){const r=event.target.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)event.target.close();}});
document.addEventListener('visibilitychange',()=>{clearTimeout(pollTimer);if(!document.hidden)refresh(true);});
window.addEventListener('online',()=>refresh(true));
if(navigator.modelContext?.registerTool){try{navigator.modelContext.registerTool({name:'submit_x_post',description:'Submit an X post and Solana wallet. The post is checked for the coin ticker and positive promotion; approved posts are paid in SOL automatically.',inputSchema:{type:'object',properties:{postUrl:{type:'string'},wallet:{type:'string'}},required:['postUrl','wallet'],additionalProperties:false},execute:async({postUrl,wallet})=>({content:[{type:'text',text:JSON.stringify(await submit(postUrl,wallet))}]})});}catch{}}
await refresh(true);
