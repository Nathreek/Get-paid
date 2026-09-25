// Launch page: the server builds the pump.fun transaction, the launcher's wallet signs and sends it,
// then the server confirms the coin on-chain and the page opens the coin's own shill page.
import { normalizeWallet, encodeBase58 } from './model.js';
const $=selector=>document.querySelector(selector);
function element(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
const status=message=>{$('#form-status').textContent=message;};
const fail=message=>{$('#form-error').textContent=message;status('');};
let account=null,wallet=null,chain='solana:mainnet',busy=false;

// Wallet Standard discovery: Phantom, Solflare, Backpack and others register themselves here.
const wallets=[];
const register=(...found)=>{for(const item of found)if(item.features?.['standard:connect']&&item.features?.['solana:signAndSendTransaction']&&!wallets.includes(item))wallets.push(item);showWallets();return()=>{};};
window.addEventListener('wallet-standard:register-wallet',event=>event.detail?.({register}));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready',{detail:{register}}));

function showWallets(){
  const holder=$('#wallet-buttons');holder.replaceChildren();
  if(account){$('#wallet-status').replaceChildren(document.createTextNode('Paying from '),element('code','',`${account.address.slice(0,4)}…${account.address.slice(-4)}`));const change=element('button','','Change');change.type='button';change.onclick=()=>{account=null;wallet=null;showWallets();};holder.append(change);return;}
  $('#wallet-status').textContent=wallets.length?'Connect the wallet that pays for the launch.':'No Solana wallet found. Install Phantom or Solflare, then reload.';
  for(const item of wallets){
    const button=element('button','',`Connect ${item.name}`);button.type='button';
    button.onclick=async()=>{try{const {accounts}=await item.features['standard:connect'].connect();account=accounts[0]||null;wallet=account&&item;showWallets();}catch{fail('The wallet did not connect. Please try again.');}};
    holder.append(button);
  }
}
showWallets();

async function api(url,body){
  const response=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||(response.status>=500?`The server did not finish in time (${response.status}). Please try again in a minute.`:'Something went wrong. Please try again.'));
  return data;
}
const readImage=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read that image.'));reader.readAsDataURL(file);});
const bytesOf=base64=>Uint8Array.from(atob(base64),char=>char.charCodeAt(0));

$('#image').addEventListener('change',()=>{
  const file=$('#image').files[0];if(!file)return;
  if(file.size>2*1024*1024){fail('The image must be 2 MB or smaller.');$('#image').value='';return;}
  const img=element('img');img.alt='';img.src=URL.createObjectURL(file);img.id='image-preview';$('#image-preview').replaceWith(img);$('#image-label').textContent=file.name;$('#form-error').textContent='';
});
$('#symbol').addEventListener('input',event=>{event.target.value=event.target.value.replace(/[^A-Za-z0-9]/g,'').toUpperCase();});

$('#launch-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;$('#form-error').textContent='';
  const file=$('#image').files[0];
  if(!file)return fail('Add an image for the coin.');
  if(!$('#name').value.trim())return fail('Give the coin a name.');
  if(!$('#symbol').value.trim())return fail('Give the coin a ticker.');
  if(!account)return fail('Connect your wallet first.');
  busy=true;const button=$('#launch-button');button.disabled=true;
  try{
    status('Uploading the image and building the launch…');
    const prepared=await api('/api/launch',{
      name:$('#name').value,symbol:$('#symbol').value,description:$('#description').value,image:await readImage(file),
      twitter:$('#twitter').value,telegram:$('#telegram').value,website:$('#website').value,devBuySol:Number($('#dev-buy').value||0),launcher:normalizeWallet(account.address),
    });
    status('Approve the launch in your wallet…');
    const [output]=await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({account,chain,transaction:bytesOf(prepared.transaction)});
    const signature=encodeBase58(output.signature);
    status('Launching on pump.fun…');
    for(let attempt=0;attempt<30;attempt++){
      const result=await api('/api/launch/confirm',{mint:prepared.mint,signature}).catch(()=>null);
      if(result?.status==='live'){status('Live! Opening your coin…');location.href=`/coin/${prepared.mint}`;return;}
      await new Promise(resolve=>setTimeout(resolve,3000));
    }
    fail(`The launch was sent but is not confirmed yet. Check your wallet; if it went through, your coin appears at /coin/${prepared.mint} within a few minutes.`);
  }catch(error){fail(/reject|denied|cancel/i.test(error.message)?'You cancelled the launch in your wallet. Nothing was sent.':error.message);}
  finally{busy=false;button.disabled=false;}
});

// Match the wallet's network to the server's (devnet while testing).
fetch('/api/coins').then(response=>response.json()).then(data=>{
  if(data.cluster==='devnet')chain='solana:devnet';
  if(!data.launchesEnabled){$('#launch-button').disabled=true;status('Coin launches are not switched on yet.');}
}).catch(()=>{});
