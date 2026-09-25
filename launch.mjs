// Coin launches on pump.fun. The launcher's wallet pays and signs; the coin's own GET-PAID wallet
// (derived from MASTER_SEED) is set as creator, so every creator fee lands where only the server can spend it.
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import { normalizeWallet } from './dist/model.js';
import { coinKeypair } from './wallets.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const unavailable = message => Object.assign(new Error(message), { status: 503 });
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_DEV_BUY_SOL = 50;
// Claiming only makes sense above the payout wallet's rent minimum (~0.00089 SOL).
const MIN_CLAIM_LAMPORTS = 2_000_000;
// Once a coin wallet holds this much, it pays for its own claims instead of the main payout wallet.
const SELF_PAY_LAMPORTS = 10_000_000;

function optionalUrl(value, label, hosts) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw invalid(`${label} must be a full https:// link.`); }
  if (url.protocol !== 'https:' || (hosts && !hosts.includes(url.hostname.replace(/^www\./, '')))) throw invalid(`${label} must be an https:// link${hosts ? ` on ${hosts[0]}` : ''}.`);
  return url.href.slice(0, 200);
}

// Checks everything the launcher typed before any upload or transaction is made.
export function validateLaunch(input) {
  const name = String(input.name || '').trim(), symbol = String(input.symbol || '').trim().replace(/^\$/, '').toUpperCase();
  if (!name || [...name].length > 32) throw invalid('Give the coin a name of up to 32 characters.');
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw invalid('The ticker must be 1–10 letters or numbers.');
  const description = String(input.description || '').trim();
  if ([...description].length > 500) throw invalid('Keep the description under 500 characters.');
  const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(input.image || ''));
  if (!match || !IMAGE_TYPES[match[1]]) throw invalid('Add a PNG, JPG, GIF or WebP image for the coin.');
  const image = Buffer.from(match[2], 'base64');
  if (!image.length || image.length > MAX_IMAGE_BYTES) throw invalid('The image must be 2 MB or smaller.');
  const devBuySol = Number(input.devBuySol || 0);
  if (!Number.isFinite(devBuySol) || devBuySol < 0 || devBuySol > MAX_DEV_BUY_SOL) throw invalid(`The first buy must be between 0 and ${MAX_DEV_BUY_SOL} SOL.`);
  return {
    name, symbol, description, image, imageType: match[1], devBuySol,
    launcher: normalizeWallet(input.launcher || ''),
    twitter: optionalUrl(input.twitter, 'The X link', ['x.com', 'twitter.com']),
    telegram: optionalUrl(input.telegram, 'The Telegram link', ['t.me']),
    website: optionalUrl(input.website, 'The website'),
  };
}

// Pinata: the image first, then pump.fun-style metadata that points at it.
export function createPinata({ jwt, gateway = 'https://ipfs.io', fetcher = fetch }) {
  const base = (/^https?:\/\//i.test(gateway.trim()) ? gateway.trim() : `https://${gateway.trim()}`).replace(/\/+$/, '');
  async function pin(url, body, headers = {}) {
    const response = await fetcher(url, { method: 'POST', body, headers: { Authorization: `Bearer ${jwt}`, ...headers }, signal: AbortSignal.timeout(30000) });
    const data = response.ok ? await response.json() : null;
    if (!data?.IpfsHash) throw unavailable('Could not upload the coin image. Please try again.');
    return `${base}/ipfs/${data.IpfsHash}`;
  }
  return async function upload(coin) {
    const form = new FormData();
    form.append('file', new Blob([coin.image], { type: coin.imageType }), `${coin.symbol.toLowerCase()}.${IMAGE_TYPES[coin.imageType]}`);
    const image = await pin('https://api.pinata.cloud/pinning/pinFileToIPFS', form);
    const metadata = { name: coin.name, symbol: coin.symbol, description: coin.description, image, showName: true, createdOn: 'https://get-paid.xyz',
      ...(coin.twitter && { twitter: coin.twitter }), ...(coin.telegram && { telegram: coin.telegram }), ...(coin.website && { website: coin.website }) };
    const uri = await pin('https://api.pinata.cloud/pinning/pinJSONToIPFS', JSON.stringify({ pinataContent: metadata, pinataMetadata: { name: `${coin.symbol}.json` } }), { 'Content-Type': 'application/json' });
    return { image, uri };
  };
}

// Collects a creator's fees from the bonding curve and PumpSwap. Returns null when a sponsored claim is too small to repay its sponsor.
export async function claimTransaction({ connection, online, owner, payer, available, blockhash, lastValidBlockHeight }) {
  const transaction = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...await online.collectCoinCreatorFeeInstructions(owner, payer));
  if (payer.equals(owner)) return transaction;
  // PumpSwap pays creator fees as wrapped SOL. The SDK only unwraps it when the creator pays the fee itself,
  // so close the account here too: payouts send plain SOL.
  const wrapped = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID);
  transaction.add(createCloseAccountInstruction(wrapped, owner, owner, [], TOKEN_PROGRAM_ID));
  // The coin pays the main wallet back in the same transaction: the network fee plus the rent of every account
  // created for it. Otherwise tiny, repeated claims could slowly drain the main wallet into a coin's payouts.
  const created = transaction.instructions.filter(instruction => instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).length;
  const refund = created * await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE) + 2 * 5000;
  if (available < refund + MIN_CLAIM_LAMPORTS) return null;
  return transaction.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: payer, lamports: refund }));
}

export function createLauncher({ rpcUrl, seed, store, upload, feePayer = null, log = console }) {
  const connection = new Connection(rpcUrl, 'confirmed'), online = new OnlinePumpSdk(connection);
  const walletFor = index => coinKeypair(seed, index);

  async function prepare(input) {
    if (!upload) throw unavailable('Coin launches are not switched on yet.');
    const coin = validateLaunch(input);
    if (await store.tickerTaken(coin.symbol)) throw Object.assign(new Error(`$${coin.symbol} is already running on GET-PAID. Pick another ticker.`), { status: 409 });
    const { image, uri } = await upload(coin);
    const mint = Keypair.generate(), user = new PublicKey(coin.launcher);
    const index = await store.reserveCoin({ id: mint.publicKey.toBase58(), ticker: coin.symbol, name: coin.name, description: coin.description, image, twitter: coin.twitter, telegram: coin.telegram, website: coin.website, launcher: coin.launcher },
      index => walletFor(index).publicKey.toBase58());
    const creator = walletFor(index).publicKey;
    const base = { mint: mint.publicKey, name: coin.name, symbol: coin.symbol, uri, creator, user, mayhemMode: false };
    let instructions;
    if (coin.devBuySol > 0) {
      const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
      const solAmount = new BN(Math.round(coin.devBuySol * LAMPORTS_PER_SOL));
      instructions = await PUMP_SDK.createV2AndBuyInstructions({ ...base, global, solAmount, amount: getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: PublicKey.default }) });
    } else instructions = [await PUMP_SDK.createV2Instruction(base)];
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({ feePayer: user, blockhash, lastValidBlockHeight })
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ...instructions);
    // The mint key signs here and is then discarded: the signed transaction is the only way this coin can ever be created.
    transaction.partialSign(mint);
    return { mint: mint.publicKey.toBase58(), payoutWallet: creator.toBase58(), transaction: transaction.serialize({ requireAllSignatures: false }).toString('base64') };
  }

  // A coin goes live once its bonding curve exists on-chain with our wallet as creator.
  async function confirm(id, signature = null) {
    const coin = await store.coinRow(id);
    if (!coin) throw Object.assign(new Error('Unknown coin.'), { status: 404 });
    if (coin.status === 'live') return coin;
    let curve;
    try { curve = await online.fetchBondingCurve(id); } catch { return coin; }
    if (!curve.creator.equals(walletFor(coin.wallet_index).publicKey)) { await store.setCoinStatus(id, 'rejected'); throw Object.assign(new Error('That coin was not created with its GET-PAID wallet.'), { status: 409 }); }
    await store.setCoinStatus(id, 'live', signature);
    return store.coinRow(id);
  }

  // Launches whose confirm call never arrived (tab closed): settle them from the chain.
  let settling = 0;
  async function settlePending() {
    if (Date.now() - settling < 30000) return;
    settling = Date.now();
    for (const coin of await store.pendingCoins()) {
      try { const row = await confirm(coin.id); if (row.status === 'pending' && Date.now() - coin.created_at > 15 * 60000) await store.setCoinStatus(coin.id, 'abandoned'); }
      catch (error) { log.error?.('Launch check failed:', error.message); }
    }
  }

  // Unclaimed creator fees on the bonding curve and PumpSwap, in lamports.
  const unclaimed = async index => Number(await online.getCreatorVaultBalanceBothPrograms(walletFor(index).publicKey));

  // Moves this coin's creator fees into its payout wallet. The main payout wallet pays the network fee when set,
  // so a brand-new coin wallet with 0 SOL can still claim.
  async function claimFees(index) {
    const owner = walletFor(index), available = await unclaimed(index);
    if (available < MIN_CLAIM_LAMPORTS) return false;
    const payer = !feePayer || await connection.getBalance(owner.publicKey) >= SELF_PAY_LAMPORTS ? owner : feePayer;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const transaction = await claimTransaction({ connection, online, owner: owner.publicKey, payer: payer.publicKey, available, blockhash, lastValidBlockHeight });
    if (!transaction) return false;
    transaction.sign(...new Map([payer, owner].map(key => [key.publicKey.toBase58(), key])).values());
    const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 5 });
    const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (result.value.err) throw new Error('Fee claim failed on-chain.');
    log.log?.(`Claimed creator fees for coin wallet #${index}: ${signature}`);
    return true;
  }

  return { enabled: Boolean(upload), prepare, confirm, settlePending, claimFees, unclaimed, walletFor };
}
