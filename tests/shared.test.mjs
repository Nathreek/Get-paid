import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createStore, payoutCents, TIERS, TIER_SIZE } from '../store.mjs';
import { createAppServer } from '../http-server.mjs';

const wallets = ['7CVZZLWaerL6b42Bo5kkpKnEEGXYf8MLAUVAiNLymqiv', '11111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 'Vote111111111111111111111111111111111111111', 'Stake11111111111111111111111111111111111111'];
const post = i => `https://x.com/user${i}/status/${1790000000000000000n + BigInt(i)}`;
const verify = async value => ({ tweetId: value.split('/').at(-1), author: value.split('/')[3].toLowerCase(), text: '$PAID 🚀' });
const quiet = { warn() {}, error() {} };

// A fake payer: records transfers; outcome() decides what each send does.
function fakePayer(outcome = () => 'confirmed') {
  const sent = [];
  return {
    sent, balance: 1e12, statuses: new Map(),
    async canAfford(lamports) { return this.balance >= lamports; },
    async prepare(to, lamports) {
      const signature = `sig${sent.length}-${randomUUID()}`;
      return { signature, lastValidBlockHeight: 100, send: async () => { const result = outcome(signature); if (result instanceof Error) throw result; sent.push({ to, lamports, signature }); return result; } };
    },
    async status(signature) { return this.statuses.get(signature) || 'pending'; },
  };
}
async function makeStore(options = {}) {
  let time = 1_000_000;
  const store = await createStore({ url: ':memory:', verify, price: async () => 200, payoutsEnabled: true, payoutIntervalMs: 0, clock: () => time++, log: quiet, ...options });
  return store;
}

test('payouts start at $3–5, climb through tiers, never decrease and cap at $40', () => {
  let previous = 0;
  for (let position = 0; position < TIERS.length * TIER_SIZE + 50; position++) {
    const cents = payoutCents(position, previous), [low, high] = TIERS[Math.min(TIERS.length - 1, Math.floor(position / TIER_SIZE))];
    assert.ok(cents >= low && cents <= high && cents >= previous, `position ${position}: ${cents}`); previous = cents;
  }
  assert.ok(payoutCents(0) <= 500 && previous <= 4000);
});

test('approved posts are queued, paid automatically in SOL, and amounts ascend', async () => {
  const payer = fakePayer(), store = await makeStore({ payer });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await store.submit(post(i), wallets[i])).status, 'queued');
    for (let i = 0; i < 5; i++) await store.processPayouts();
    const state = await store.state();
    assert.equal(payer.sent.length, 5);
    assert.ok(state.records.every(record => record.status === 'sent' && record.signature));
    const amounts = [...state.records].reverse().map(record => record.amountCents);
    assert.deepEqual(amounts, [...amounts].sort((a, b) => a - b));
    assert.ok(amounts[0] >= 300 && amounts[0] <= 500);
    assert.equal(payer.sent[0].lamports, Math.round(amounts[0] / 100 / 200 * 1e9));
    assert.equal(state.latestPayout.id, state.records.find(record => record.signature === payer.sent[4].signature).id);
    assert.equal(state.paidCount, 5);
  } finally { store.close(); }
});

test('the same post, wallet or X account cannot be rewarded twice', async () => {
  const store = await makeStore({ payer: fakePayer() });
  try {
    await store.submit(post(1), wallets[0]);
    await assert.rejects(() => store.submit(post(1), wallets[1]), /already been submitted/);
    await assert.rejects(() => store.submit(post(2), wallets[0]), /wallet has already/);
    await assert.rejects(() => store.submit('https://x.com/user1/status/42', wallets[2]), /@user1 has already/);
  } finally { store.close(); }
});

test('nothing is sent when payouts are disabled, the wallet is short on SOL, or the daily cap is hit', async () => {
  const payer = fakePayer();
  let store = await makeStore({ payer, payoutsEnabled: false });
  await store.submit(post(1), wallets[0]); await store.processPayouts(); assert.equal(payer.sent.length, 0); store.close();
  store = await makeStore({ payer }); payer.balance = 0;
  await store.submit(post(1), wallets[0]); await store.processPayouts(); assert.equal(payer.sent.length, 0);
  assert.equal((await store.state()).records[0].status, 'queued'); store.close();
  store = await makeStore({ payer: fakePayer(), dailyCapCents: 250 });
  await store.submit(post(1), wallets[0]); await store.processPayouts(); assert.equal((await store.state()).records[0].status, 'queued'); store.close();
});

test('an unconfirmed payout is settled from its signature instead of being paid again', async () => {
  const signatures = [];
  const payer = fakePayer(signature => { signatures.push(signature); return new Error('confirmation timed out'); });
  const store = await makeStore({ payer });
  try {
    await store.submit(post(1), wallets[0]);
    await store.processPayouts();
    assert.equal((await store.state()).records[0].status, 'sending');
    await store.processPayouts();
    assert.equal(signatures.length, 1, 'still pending on-chain: must not send again');
    payer.statuses.set(signatures[0], 'confirmed');
    await store.processPayouts();
    const [row] = (await store.state()).records;
    assert.equal(row.status, 'sent'); assert.equal(row.signature, signatures[0]); assert.equal(signatures.length, 1);
  } finally { store.close(); }
});

test('an expired unconfirmed payout returns to the queue with the same amount', async () => {
  const signatures = [];
  const payer = fakePayer(signature => { signatures.push(signature); return new Error('timed out'); });
  const store = await makeStore({ payer });
  try {
    await store.submit(post(1), wallets[0]);
    await store.processPayouts();
    const amount = (await store.state()).records[0].amountCents;
    payer.statuses.set(signatures[0], 'expired');
    await store.processPayouts();
    assert.equal(signatures.length, 2);
    assert.equal((await store.state()).records[0].amountCents, amount);
    payer.statuses.set(signatures[1], 'confirmed');
    await store.processPayouts();
    const [row] = (await store.state()).records;
    assert.equal(row.status, 'sent'); assert.equal(signatures.length, 2);
  } finally { store.close(); }
});

test('a transfer the network refuses is retried, then marked not paid after 3 refusals', async () => {
  const payer = fakePayer(() => Object.assign(new Error('Blockhash not found'), { rejected: true }));
  const store = await makeStore({ payer });
  try {
    await store.submit(post(1), wallets[0]);
    for (let i = 0; i < 2; i++) { await store.processPayouts(); assert.equal((await store.state()).records[0].status, 'queued'); }
    await store.processPayouts(); assert.equal((await store.state()).records[0].status, 'failed');
  } finally { store.close(); }
});

test('database survives close and reopen', async () => {
  const file = path.join(tmpdir(), `get-paid-test-${randomUUID()}.db`);
  let store = await makeStore({ url: 'file:' + file });
  await store.submit(post(1), wallets[0]); store.close();
  store = await makeStore({ url: 'file:' + file }); assert.equal((await store.state()).total, 1); store.close();
  for (const suffix of ['', '-wal', '-shm']) await unlink(file + suffix).catch(() => {});
});

test('API validates input, rejects cross-site writes and limits submissions per IP', async () => {
  const store = await makeStore({ payoutsEnabled: false });
  const server = createAppServer({ directory: fileURLToPath(new URL('../dist/', import.meta.url)), store, rateLimit: 3 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, headers = { 'Content-Type': 'application/json', Origin: base };
  const submit = (body, extra = {}) => fetch(base + '/api/submissions', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    const created = await submit({ post: post(1), wallet: wallets[0] }); assert.equal(created.status, 201);
    assert.equal((await created.json()).record.wallet, wallets[0]);
    const bad = await submit({ post: post(2), wallet: 'not-a-wallet' }); assert.equal(bad.status, 400); assert.match((await bad.json()).error, /Remove/);
    assert.equal((await submit({ post: post(1), wallet: wallets[1] })).status, 409);
    assert.equal((await submit({})).status, 429);
    assert.equal((await submit({}, { Origin: 'https://unrelated.example' })).status, 403);
    const state = await fetch(base + '/api/state'); assert.equal((await state.json()).total, 1);
    assert.equal((await fetch(base + '/api/state', { headers: { 'If-None-Match': state.headers.get('etag') } })).status, 304);
    const image = await fetch(base + '/assets/gp-monogram.png'); assert.equal(image.headers.get('content-type'), 'image/png'); await image.arrayBuffer();
    assert.equal((await fetch(base + '/../data/get-paid.db')).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); }
});
