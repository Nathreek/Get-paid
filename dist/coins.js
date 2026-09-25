// The coin directory: the site's own coin first, then every coin launched through GET-PAID.
import { config } from './config.js';
const $=selector=>document.querySelector(selector);
function element(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
const sol=lamports=>`${(lamports/1e9).toFixed(lamports<1e9?3:2)} SOL`;
let revision=-1;

function card(coin){
  const main=coin.id==='main',item=element('li'),anchor=element('a','coin-card');anchor.href=main?'/':`/coin/${coin.id}`;
  const head=element('div','coin-card-head');
  if(coin.image){const img=element('img');img.src=coin.image;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.onerror=()=>img.replaceWith(element('span','coin-fallback',coin.ticker.slice(0,1)));head.append(img);}
  else if(main){const img=element('img');img.src='/assets/gp-monogram.png';img.alt='';img.style.background='#fff';head.append(img);}
  else head.append(element('span','coin-fallback',coin.ticker.slice(0,1)));
  const who=element('div');who.style.minWidth='0';who.append(element('strong','',coin.name),element('span','',`$${coin.ticker||config.ticker}`));head.append(who);
  if(main)head.append(element('span','home-tag','HOME'));
  const stats=element('dl');
  for(const [label,value] of [['Paid out',sol(coin.paidLamports)],['Posts paid',coin.paidCount],['In queue',coin.queued]]){const box=element('div');box.append(element('dt','',label),element('dd','',String(value)));stats.append(box);}
  anchor.append(head,element('p','',coin.description||(main?'The coin behind GET-PAID. Shill it on X and get paid in SOL.':'Launched on GET-PAID. Creator fees pay its shillers.')),stats,element('span','shill',`Shill $${coin.ticker||config.ticker} ↗`));
  item.append(anchor);return item;
}

async function refresh(){
  try{
    const response=await fetch('/api/coins',{signal:AbortSignal.timeout(20000)});const data=await response.json();
    if(!response.ok)throw new Error(data.error);
    $('#connection-status').hidden=true;
    if(data.revision!==revision){revision=data.revision;$('#coin-grid').replaceChildren(...data.coins.map(card));}
  }catch{$('#connection-status').textContent='Could not load coins. Retrying automatically.';$('#connection-status').hidden=false;}
  setTimeout(refresh,15000);
}
refresh();
