import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { createStore } from '../store.mjs';
import { createAppServer } from '../http-server.mjs';
import { parseMasterSeed, coinKeypair } from '../wallets.mjs';
import { validateLaunch, claimTransaction } from '../launch.mjs';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const MINT = 'Hq8mSUDHy2d6fz3LNwVaRMmJWu4cY4XkhVsA4pDUpump', MINT2 = 'Ghy4hQrD2RAQvUz3AqXhiXHrwMvXz6r6GhjUFhdQpump';
const wallets = ['7CVZZLWaerL6b42Bo5kkpKnEEGXYf8MLAUVAiNLymqiv', '11111111111111111111111111111111'];
const post = i => `https://x.com/user${i}/status/${1790000000000000000n + BigInt(i)}`;
const quiet = { warn() {}, error() {}, log() {} };
const PNG = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

function fakePayer(balance = 1e12) {
  const sent = [];
  return {
    sent, balance, async canAfford(lamports) { return this.balance >= lamports; }, async status() { return 'pending'; },
    async prepare(to, lamports) { const signature = `sig-${randomUUID()}`; return { signature, lastValidBlockHeight: 100, send: async () => { sent.push({ to, lamports }); this.balance -= lamports; return 'confirmed'; } }; },
  };
}
async function launchCoin(store, id, ticker, index) {
  await store.reserveCoin({ id, ticker, name: `${ticker} coin`, launcher: wallets[0] }, i => `payout-wallet-${i}`);
  await store.setCoinStatus(id, 'live', null);
  assert.equal((await store.coinRow(id)).wallet_index, index);
}

test('coin wallets follow the standard Solana derivation path, from a seed phrase or hex', () => {
  const seed = parseMasterSeed(MNEMONIC);
  // Reference values from bip39 + ed25519-hd-key, m/44'/501'/i'/0' (what Phantom shows for this phrase).
  assert.equal(coinKeypair(seed, 0).publicKey.toBase58(), 'BLeUXTx9thHGT7VJUtF9vHEmfMDgW1nnKZ9UVer2CoLX');
  assert.equal(coinKeypair(seed, 1).publicKey.toBase58(), 'EdjcxP8MmXP4yRHguEVoH75kbXVfZNFXPgNfL9NqcXXK');
  assert.equal(coinKeypair(seed, 7).publicKey.toBase58(), 'GPAJ4A3YSzzVYeTigrfxB91j8ELPcqHCCq13vJvJhna1');
  assert.equal(coinKeypair(parseMasterSeed(seed.toString('hex')), 1).publicKey.toBase58(), 'EdjcxP8MmXP4yRHguEVoH75kbXVfZNFXPgNfL9NqcXXK');
  assert.throws(() => parseMasterSeed('not a seed'), /MASTER_SEED/);
});

test('each coin has its own queue, limits, payout wallet and AI check', async () => {
  const main = fakePayer(), coinPayer = fakePayer(), checked = [];
  const verify = async (value, coin) => { checked.push(coin.ticker); return { tweetId: value.split('/').at(-1), author: value.split('/')[3].toLowerCase(), text: `$${coin.ticker} 🚀` }; };
  let time = 1_000_000;
  const store = await createStore({ url: ':memory:', verify, mainCoin: { ticker: 'GETPAID' }, payerFor: coin => coin.id === 'main' ? main : coinPayer, price: async () => 200, payoutsEnabled: true, payoutIntervalMs: 0, clock: () => time++, log: quiet });
  try {
    await launchCoin(store, MINT, 'CAT', 1);
    await store.submit(post(1), wallets[0]);
    // The same post, wallet and X account can be rewarded once per coin.
    const record = await store.submit(post(1), wallets[0], MINT);
    assert.equal(record.status, 'queued');
    assert.deepEqual(checked, ['GETPAID', 'CAT']);
    await assert.rejects(() => store.submit(post(1), wallets[1], MINT), /already been submitted/);
    await assert.rejects(() => store.submit(post(2), wallets[0], MINT2), error => error.status === 404);
    await store.processPayouts();
    assert.equal(main.sent.length, 1); assert.equal(coinPayer.sent.length, 1);
    const coinState = await store.state(0, MINT), mainState = await store.state(0);
    assert.equal(coinState.coin.ticker, 'CAT'); assert.equal(coinState.coin.payoutWallet, 'payout-wallet-1'); assert.equal(coinState.coin.walletIndex, undefined);
    assert.equal(coinState.total, 1); assert.equal(mainState.total, 1); assert.equal(coinState.paidCount, 1);
    const listed = (await store.coins()).coins;
    assert.deepEqual(listed.map(coin => [coin.id, coin.paidCount]), [['main', 1], [MINT, 1]]);
    assert.ok(await store.tickerTaken('cat')); assert.ok(await store.tickerTaken('GETPAID')); assert.ok(!await store.tickerTaken('DOG'));
  } finally { store.close(); }
});

test('a launched coin claims its creator fees when its wallet runs low, and waits when there are none', async () => {
  const coinPayer = fakePayer(0), claims = [];
  const verify = async value => ({ tweetId: value.split('/').at(-1), author: value.split('/')[3], text: '$CAT' });
  let time = 1_000_000;
  const store = await createStore({ url: ':memory:', verify, payerFor: coin => coin.id === 'main' ? null : coinPayer,
    claimFees: async coin => { claims.push(coin.walletIndex); if (claims.length === 1) return false; coinPayer.balance = 1e12; return true; },
    price: async () => 200, payoutsEnabled: true, payoutIntervalMs: 0, clock: () => time, log: quiet });
  try {
    await launchCoin(store, MINT, 'CAT', 1);
    await store.submit(post(1), wallets[0], MINT);
    await store.processPayouts();
    assert.deepEqual(claims, [1]); assert.equal(coinPayer.sent.length, 0);
    await store.processPayouts();
    assert.deepEqual(claims, [1], 'claims are spaced out');
    time += 5 * 60000;
    await store.processPayouts();
    assert.deepEqual(claims, [1, 1]); assert.equal(coinPayer.sent.length, 1);
  } finally { store.close(); }
});

test('many coins are paid at the same time, and coins waiting for fees never block the others', async () => {
  const { Keypair } = await import('@solana/web3.js');
  const ids = Array.from({ length: 12 }, () => Keypair.generate().publicKey.toBase58());
  let active = 0, peak = 0;
  // Each send takes a moment, so parallel payouts overlap. The first two coins have no fees yet.
  const payers = new Map(ids.map((id, i) => [id, { sent: 0, balance: i < 2 ? 0 : 1e12,
    async canAfford(lamports) { return this.balance >= lamports; }, async status() { return 'pending'; },
    async prepare() { return { signature: `sig-${randomUUID()}`, lastValidBlockHeight: 100, send: async () => { peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 20)); active--; this.sent++; return 'confirmed'; } }; } }]));
  const verify = async value => ({ tweetId: value.split('/').at(-1), author: value.split('/')[3], text: 'ok' });
  let time = 1_000_000;
  const store = await createStore({ url: ':memory:', verify, payerFor: coin => payers.get(coin.id) || null, price: async () => 200, payoutsEnabled: true, payoutIntervalMs: 10000, clock: () => time, log: quiet });
  try {
    for (const [i, id] of ids.entries()) { await launchCoin(store, id, `C${i}`, i + 1); await store.submit(post(i), wallets[0], id); }
    await store.processPayouts();
    assert.ok(peak > 1, 'payouts for different coins run at the same time');
    time += 10000; await store.processPayouts();
    const unpaid = ids.filter(id => payers.get(id).sent === 0);
    assert.deepEqual(unpaid, ids.slice(0, 2), 'every coin with fees was paid within two runs');
  } finally { store.close(); }
});

test('viewers share one read of the page data, and any change shows up at once', async () => {
  let time = 1_000_000;
  const verify = async value => ({ tweetId: value.split('/').at(-1), author: value.split('/')[3], text: 'ok' });
  const store = await createStore({ url: ':memory:', verify, price: null, clock: () => time, log: quiet });
  try {
    const first = await store.state();
    assert.equal(await store.state(), first, 'a second viewer within 2 s gets the same answer');
    await store.submit(post(1), wallets[0]);
    assert.equal((await store.state()).total, 1, 'a new submission is visible immediately');
    const again = await store.state();
    time += 2000;
    assert.notEqual(await store.state(), again, 'after 2 s the data is read again');
  } finally { store.close(); }
});

test('coins only go live once confirmed, never share a wallet, and unfinished launches stay hidden', async () => {
  const store = await createStore({ url: ':memory:', verify: null, price: null, log: quiet });
  try {
    await store.reserveCoin({ id: MINT, ticker: 'CAT', name: 'Cat', launcher: wallets[0] }, i => `w${i}`);
    await store.reserveCoin({ id: MINT2, ticker: 'DOG', name: 'Dog', launcher: wallets[0] }, i => `w${i}`);
    assert.deepEqual([(await store.coinRow(MINT)).wallet_index, (await store.coinRow(MINT2)).wallet_index], [1, 2]);
    assert.equal((await store.coins()).coins.length, 1);
    await assert.rejects(() => store.state(0, MINT), error => error.status === 404);
    await store.setCoinStatus(MINT2, 'abandoned');
    await store.setCoinStatus(MINT2, 'live');
    assert.equal((await store.coinRow(MINT2)).status, 'abandoned', 'an abandoned launch cannot come back');
    await store.setCoinStatus(MINT, 'live', 'sig');
    assert.equal((await store.coins()).coins.length, 2);
  } finally { store.close(); }
});

test('a database from before coins keeps its entries under the main coin', async () => {
  const file = path.join(tmpdir(), `get-paid-old-${randomUUID()}.db`), url = 'file:' + file;
  const old = createClient({ url });
  await old.batch([
    `CREATE TABLE submissions(id TEXT PRIMARY KEY, post TEXT NOT NULL, tweet_id TEXT NOT NULL, author TEXT NOT NULL, wallet TEXT NOT NULL, tweet_text TEXT NOT NULL,
      status TEXT NOT NULL, note TEXT, amount_cents INTEGER, lamports INTEGER, sol_price REAL, signature TEXT, last_valid_height INTEGER,
      created_at INTEGER NOT NULL, claimed_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, paid_at INTEGER)`,
    'CREATE UNIQUE INDEX submissions_tweet ON submissions(tweet_id)',
    "INSERT INTO submissions(id,post,tweet_id,author,wallet,tweet_text,status,created_at) VALUES('a','https://x.com/user1/status/1790000000000000001','1790000000000000001','user1','7CVZZLWaerL6b42Bo5kkpKnEEGXYf8MLAUVAiNLymqiv','$GETPAID','queued',1)",
  ], 'write');
  old.close();
  const verify = async value => ({ tweetId: value.split('/').at(-1), author: value.split('/')[3], text: '$CAT' });
  const store = await createStore({ url, verify, price: null, log: quiet });
  try {
    assert.equal((await store.state()).total, 1);
    await launchCoin(store, MINT, 'CAT', 1);
    assert.equal((await store.submit(post(1), wallets[1], MINT)).status, 'queued', 'the same post can join another coin');
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) await unlink(file + suffix).catch(() => {});
  }
});

test('launch details are checked before anything is uploaded', () => {
  const good = { name: 'Cat Coin', symbol: '$cat', image: PNG, launcher: wallets[0], twitter: 'https://x.com/catcoin', devBuySol: '0.5' };
  const coin = validateLaunch(good);
  assert.equal(coin.symbol, 'CAT'); assert.equal(coin.devBuySol, 0.5); assert.equal(coin.imageType, 'image/png'); assert.equal(coin.website, '');
  assert.throws(() => validateLaunch({ ...good, symbol: 'CAT COIN' }), /ticker/);
  assert.throws(() => validateLaunch({ ...good, image: 'data:image/svg+xml;base64,PHN2Zz4=' }), /image/);
  assert.throws(() => validateLaunch({ ...good, twitter: 'https://evil.test/cat' }), /x\.com/);
  assert.throws(() => validateLaunch({ ...good, website: 'javascript:alert(1)' }), /https/);
  assert.throws(() => validateLaunch({ ...good, devBuySol: 500 }), /first buy/);
  assert.throws(() => validateLaunch({ ...good, launcher: 'nope' }), error => error.status === 400);
});

test('a claim sponsored by the main wallet pays it back in the same transaction', async () => {
  const { PublicKey, SystemProgram, SystemInstruction, TransactionInstruction } = await import('@solana/web3.js');
  const { ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
  const owner = new PublicKey(wallets[0]), payer = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'), rent = 2039280;
  // Two token accounts get created for the claim, paid by the main wallet.
  const createAta = new TransactionInstruction({ programId: ASSOCIATED_TOKEN_PROGRAM_ID, keys: [], data: Buffer.alloc(0) });
  const online = { collectCoinCreatorFeeInstructions: async () => [createAta, createAta] };
  const connection = { getMinimumBalanceForRentExemption: async () => rent };
  const base = { connection, online, owner, payer, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 };
  const tx = await claimTransaction({ ...base, available: 50_000_000 });
  const refund = tx.instructions.at(-1);
  assert.ok(refund.programId.equals(SystemProgram.programId));
  const { fromPubkey, toPubkey, lamports } = SystemInstruction.decodeTransfer(refund);
  assert.ok(fromPubkey.equals(owner) && toPubkey.equals(payer));
  assert.equal(Number(lamports), 2 * rent + 10000);
  assert.equal(await claimTransaction({ ...base, available: 2 * rent + 10000 + 1_999_999 }), null, 'too small to repay: skipped');
  // A coin wallet paying for itself needs no refund.
  assert.equal((await claimTransaction({ ...base, payer: owner, available: 50_000_000 })).instructions.length, 2);
});

test('coin pages, the coin list and the launch API are served', async () => {
  const verify = async value => ({ tweetId: value.split('/').at(-1), author: 'a', text: '$CAT' });
  const store = await createStore({ url: ':memory:', verify, price: null, log: quiet });
  await launchCoin(store, MINT, 'CAT', 1);
  const server = createAppServer({ directory: fileURLToPath(new URL('../dist/', import.meta.url)), store });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = async route => { const response = await fetch(base + route); return [response.status, response.headers.get('content-type'), await response.text()]; };
  try {
    for (const [route, marker] of [['/coins', 'coin-grid'], ['/launch', 'launch-form'], [`/coin/${MINT}`, 'submission-form'], ['/coins/', 'coin-grid'], ['/explore', 'coin-grid']]) {
      const [status, type, body] = await html(route);
      assert.equal(status, 200, route); assert.match(type, /text\/html/); assert.ok(body.includes(marker), route);
    }
    assert.equal((await html('/coin/not-a-mint'))[0], 404);
    const list = await (await fetch(base + '/api/coins')).json();
    assert.deepEqual(list.coins.map(coin => coin.ticker), ['', 'CAT']); assert.equal(list.launchesEnabled, false);
    assert.equal((await (await fetch(`${base}/api/state?coin=${MINT}`)).json()).coin.ticker, 'CAT');
    assert.equal((await fetch(`${base}/api/state?coin=../x`)).status, 400);
    assert.equal((await fetch(`${base}/api/state?coin=${MINT2}`)).status, 404);
    const launch = await fetch(base + '/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' });
    assert.equal(launch.status, 503);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); }
});

test("the site coin's contract address can be set live, and posts are then checked against it", async () => {
  const seen = [];
  const verify = async (value, coin) => { seen.push(coin.coinAddress); return { tweetId: value.split('/').at(-1), author: value.split('/')[3], text: 'ok' }; };
  const store = await createStore({ url: ':memory:', verify, mainCoin: { ticker: 'GETPAID', coinAddress: '' }, price: null, log: quiet });
  try {
    assert.equal((await store.state()).coin.coinAddress, '');
    await assert.rejects(() => store.setMainCoinAddress('not-an-address'), error => error.status === 400);
    assert.equal(await store.setMainCoinAddress(` ${MINT} `), MINT);
    assert.equal((await store.state()).coin.coinAddress, MINT, 'visible straight away');
    assert.equal((await store.coins()).coins[0].coinAddress, MINT);
    await store.submit(post(1), wallets[0]);
    assert.deepEqual(seen, [MINT], 'the post check accepts the CA as well as $GETPAID');
  } finally { store.close(); }
});
