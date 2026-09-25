// Coin launches on pump.fun. The launcher's wallet pays and signs; the coin's own GET-PAID wallet
// (derived from MASTER_SEED) is set as creator, so every creator fee lands where only the server can spend it.
import { AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
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
const MAX_TRANSACTION_BYTES = 1232, LOOKUP_TABLE_KEY = 'launch_lookup_table';

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

// The instructions for one launch: create the coin with `creator` as its fee wallet, plus the launcher's first buy if any.
// `state` (pump.fun's global and fee config) is only needed for a first buy.
export async function launchInstructions({ mint, name, symbol, uri, creator, user, devBuySol }, state) {
  const base = { mint, name, symbol, uri, creator, user, mayhemMode: false };
  const priority = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 })];
  if (!(devBuySol > 0)) return [...priority, await PUMP_SDK.createV2Instruction(base)];
  const { global, feeConfig } = state, solAmount = new BN(Math.round(devBuySol * LAMPORTS_PER_SOL));
  return [...priority, ...await PUMP_SDK.createV2AndBuyInstructions({ ...base, global, solAmount, amount: getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: PublicKey.default }) })];
}

export function createLauncher({ rpcUrl, seed, store, upload, feePayer = null, log = console }) {
  const connection = new Connection(rpcUrl, 'confirmed'), online = new OnlinePumpSdk(connection);
  const walletFor = index => coinKeypair(seed, index);

  const chainState = async () => { const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]); return { global, feeConfig }; };

  // A launch with a first buy names too many accounts for Solana's 1,232-byte transaction limit. The accounts every
  // launch shares (programs and pump.fun's global accounts) go in an address lookup table instead, created once by
  // the main payout wallet (about 0.006 SOL) and remembered in the database.
  let table = null;
  async function lookupTable(state) {
    if (table) return table;
    const saved = await store.setting(LOOKUP_TABLE_KEY);
    if (saved) {
      const { value } = await connection.getAddressLookupTable(new PublicKey(saved));
      if (value) return table = value;
    }
    if (!feePayer) return null;
    // The shared accounts are the ones that stay the same across two launches with different coins and wallets.
    const accounts = async () => { const key = () => Keypair.generate().publicKey; return new Set((await launchInstructions({ mint: key(), creator: key(), user: key(), name: 'x', symbol: 'X', uri: 'x', devBuySol: 0.01 }, state)).flatMap(instruction => [instruction.programId, ...instruction.keys.map(meta => meta.pubkey)]).map(String)); };
    const [first, second] = await Promise.all([accounts(), accounts()]);
    const addresses = [...first].filter(address => second.has(address)).map(address => new PublicKey(address));
    const [create, address] = AddressLookupTableProgram.createLookupTable({ authority: feePayer.publicKey, payer: feePayer.publicKey, recentSlot: await connection.getSlot('finalized') });
    const extend = AddressLookupTableProgram.extendLookupTable({ authority: feePayer.publicKey, payer: feePayer.publicKey, lookupTable: address, addresses });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({ feePayer: feePayer.publicKey, blockhash, lastValidBlockHeight }).add(create, extend);
    transaction.sign(feePayer);
    const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 5 });
    if ((await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')).value.err) throw new Error('Creating the lookup table failed.');
    await store.saveSetting(LOOKUP_TABLE_KEY, address.toBase58());
    log.log?.(`Created launch lookup table ${address.toBase58()} with ${addresses.length} accounts.`);
    // A table can be used from the slot after it was extended.
    for (let attempt = 0; attempt < 20; attempt++) {
      const { value } = await connection.getAddressLookupTable(address);
      if (value?.state.addresses.length && await connection.getSlot('confirmed') > value.state.lastExtendedSlot) return table = value;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw unavailable('The launch system is warming up. Please try again in a few seconds.');
  }

  async function prepare(input) {
    if (!upload) throw unavailable('Coin launches are not switched on yet.');
    const coin = validateLaunch(input);
    if (await store.tickerTaken(coin.symbol)) throw Object.assign(new Error(`$${coin.symbol} is already running on GET-PAID. Pick another ticker.`), { status: 409 });
    const { image, uri } = await upload(coin);
    const mint = Keypair.generate(), user = new PublicKey(coin.launcher), id = mint.publicKey.toBase58();
    const index = await store.reserveCoin({ id, ticker: coin.symbol, name: coin.name, description: coin.description, image, twitter: coin.twitter, telegram: coin.telegram, website: coin.website, launcher: coin.launcher },
      index => walletFor(index).publicKey.toBase58());
    const creator = walletFor(index).publicKey;
    try {
      const state = coin.devBuySol > 0 ? await chainState() : null;
      const instructions = await launchInstructions({ mint: mint.publicKey, name: coin.name, symbol: coin.symbol, uri, creator, user, devBuySol: coin.devBuySol }, state);
      const tables = state ? [await lookupTable(state).catch(error => { log.error?.('Launch lookup table unavailable:', error.message); return null; })].filter(Boolean) : [];
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions }).compileToV0Message(tables));
      // The mint key signs here and is then discarded: the signed transaction is the only way this coin can ever be created.
      transaction.sign([mint]);
      let bytes = null;
      try { bytes = transaction.serialize(); } catch {} // web3.js throws on anything over the size limit
      if (!bytes || bytes.length > MAX_TRANSACTION_BYTES) throw unavailable(tables.length ? 'This launch is too large for one Solana transaction. Try a shorter name or description link.' : 'First buys are not available right now. Launch without a first buy, and buy on pump.fun right after.');
      return { mint: id, payoutWallet: creator.toBase58(), transaction: Buffer.from(bytes).toString('base64') };
    } catch (error) {
      // Nothing was handed to the launcher, so free the ticker straight away.
      await store.setCoinStatus(id, 'abandoned').catch(() => {});
      throw error;
    }
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
