import { createClient } from '@libsql/client';
import { randomUUID, randomInt } from 'node:crypto';
import { normalizePost, normalizeWallet, tweetIdOf } from './dist/model.js';
import { Rejection } from './verify.mjs';
import { lamportsFor } from './payout.mjs';

export const PAGE_SIZE = 25;
// The site's own coin. Coins launched through the site are keyed by their mint address.
export const MAIN_COIN = 'main';
// Default payout tiers in cents. Every TIER_SIZE payouts move up one tier; the last tier is the maximum.
export const TIERS = [[500,3000]], TIER_SIZE = 30;
// Each payout gets a random amount from its slice of the tier, never below the previous one, so amounts only ascend.
export function payoutCents(position, previous = 0, random = randomInt, tiers = TIERS, tierSize = TIER_SIZE) {
  const tier = Math.min(tiers.length - 1, Math.floor(position / tierSize)), [low, high] = tiers[tier];
  const step = Math.min(tierSize - 1, position - tier * tierSize), size = (high - low) / tierSize;
  const amount = random(Math.floor(low + size * step), Math.floor(low + size * (step + 1)) + 1);
  return Math.min(high, Math.max(previous, amount));
}
const conflict = message => Object.assign(new Error(message), { status: 409 });
const notFound = () => Object.assign(new Error('That coin was not found.'), { status: 404 });
const FEE_POOL_TTL = 30000, CLAIM_EVERY = 5 * 60000, PRICE_TTL = 30000, READ_CACHE_MS = 2000;
// Coins paid at the same time per run; how long a coin waits after it could not pay (no funds yet, or its daily cap).
const PARALLEL_COINS = 8, FUNDS_WAIT = 60000, CAP_WAIT = 10 * 60000;
// How long a payout waits when X cannot be reached for its recheck; how many expired attempts before giving up.
const RECHECK_WAIT = 60000, MAX_EXPIRED = 5;
const MAIN_CA_KEY = 'main_coin_address';
const payoutKey = coin => coin === MAIN_COIN ? 'next_payout_at' : `next_payout_at:${coin}`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS submissions(
    id TEXT PRIMARY KEY, post TEXT NOT NULL, tweet_id TEXT NOT NULL, author TEXT NOT NULL, wallet TEXT NOT NULL, tweet_text TEXT NOT NULL,
    status TEXT NOT NULL, note TEXT, amount_cents INTEGER, lamports INTEGER, sol_price REAL, signature TEXT, last_valid_height INTEGER,
    created_at INTEGER NOT NULL, claimed_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, paid_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS submissions_created ON submissions(created_at DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS submissions_status ON submissions(status, created_at)',
  'CREATE INDEX IF NOT EXISTS submissions_author ON submissions(author)',
  'CREATE INDEX IF NOT EXISTS submissions_wallet ON submissions(wallet)',
  'CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  "INSERT OR IGNORE INTO metadata VALUES('revision','0'),('next_payout_at','0')",
  // status: pending (transaction handed to the launcher) → live, or abandoned / rejected. wallet_index is never reused.
  `CREATE TABLE IF NOT EXISTS coins(
    id TEXT PRIMARY KEY, ticker TEXT NOT NULL, name TEXT NOT NULL, description TEXT, image TEXT, twitter TEXT, telegram TEXT, website TEXT,
    launcher TEXT NOT NULL, wallet_index INTEGER NOT NULL UNIQUE, payout_wallet TEXT NOT NULL, status TEXT NOT NULL, signature TEXT,
    created_at INTEGER NOT NULL, launched_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS coins_status ON coins(status, launched_at DESC)',
];
// Need the coin column, so they run after the migration below.
const COIN_INDEXES = [
  'DROP INDEX IF EXISTS submissions_tweet',
  'CREATE UNIQUE INDEX IF NOT EXISTS submissions_coin_tweet ON submissions(coin, tweet_id)',
  'CREATE INDEX IF NOT EXISTS submissions_coin_created ON submissions(coin, created_at DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS submissions_coin_status ON submissions(coin, status, created_at)',
];

// status: queued → sending → sent (or failed). Rejected posts are never stored.
// Every query is scoped to one coin: each has its own queue, limits, payout wallet and totals.
// payerFor(coin) returns the wallet that pays that coin's shillers; claimFees(coin) tops it up from creator fees;
// feePool(coin) reports lamports available to it. recheck(submission, coin) throws a Rejection if a post no longer qualifies.
export async function createStore({ url, authToken, verify, recheck = null, payer = null, payerFor = coin => coin.id === MAIN_COIN ? payer : null, claimFees = null, feePool = null, mainCoin = {}, price, cluster = 'mainnet', payoutsEnabled = false, payoutIntervalMs = 10000, dailyCapCents = 10000, maxPerAccount = 1, fixedCents = 0, tiers = TIERS, tierSize = TIER_SIZE, clock = Date.now, log = console }) {
  const db = createClient({ url, authToken });
  await db.batch(SCHEMA, 'write');
  // Columns added after launch; existing databases get them on startup. Existing rows belong to the main coin.
  const columns = new Set((await db.execute('PRAGMA table_info(submissions)')).rows.map(column => column.name));
  for (const [name, type] of [['author_name', 'TEXT'], ['avatar_url', 'TEXT'], ['coin', `TEXT NOT NULL DEFAULT '${MAIN_COIN}'`]]) if (!columns.has(name)) await db.execute(`ALTER TABLE submissions ADD COLUMN ${name} ${type}`);
  await db.batch(COIN_INDEXES, 'write');
  const one = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];
  const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;
  const run = async (sql, args = []) => (await db.execute({ sql, args })).rowsAffected;
  const bump = async () => { reads.clear(); await run("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'"); reads.clear(); };
  const record = row => ({
    id: row.id, post: row.post, author: row.author, name: row.author_name || row.author, avatar: row.avatar_url || null, text: row.tweet_text, wallet: row.wallet, status: row.status, createdAt: row.created_at,
    ...(row.amount_cents === null ? {} : { amountCents: row.amount_cents }),
    ...(row.status === 'sent' ? { signature: row.signature, paidAt: row.paid_at, lamports: row.lamports } : {}),
    ...(row.status === 'failed' && row.note ? { note: row.note } : {}),
  });
  const used = async (coin, column, value) => (await one(`SELECT count(*) AS n FROM submissions WHERE coin=? AND ${column}=? AND status!='failed'`, [coin, value])).n;

  // Public description of a coin, or null when it is unknown or not live.
  const coinInfo = row => ({
    id: row.id, ticker: row.ticker, name: row.name, description: row.description || '', image: row.image || null,
    twitter: row.twitter || null, telegram: row.telegram || null, website: row.website || null,
    coinAddress: row.id, payoutWallet: row.payout_wallet, walletIndex: row.wallet_index, launched: true, launchedAt: row.launched_at,
  });
  // The site's coin. Its contract address can be set live (scripts/coin.mjs set-ca) the moment it launches; config.js is the fallback.
  const mainInfo = async () => ({ id: MAIN_COIN, ticker: mainCoin.ticker || '', name: mainCoin.name || 'GET-PAID', coinAddress: (await setting(MAIN_CA_KEY)) || mainCoin.coinAddress || '', payoutWallet: mainCoin.payoutWallet || null, launched: false });
  async function findCoin(id) {
    if (id === MAIN_COIN) return await mainInfo();
    const row = await one("SELECT * FROM coins WHERE id=? AND status='live'", [String(id)]);
    return row ? coinInfo(row) : null;
  }
  const publicCoin = ({ walletIndex, ...coin }) => coin;

  const pools = new Map();
  async function poolOf(coin) {
    if (!feePool) return null;
    const cached = pools.get(coin.id);
    if (cached && clock() - cached.at < FEE_POOL_TTL) return cached.value;
    const value = await feePool(coin).catch(() => cached?.value ?? null);
    pools.set(coin.id, { at: clock(), value });
    if (pools.size > 1000) pools.delete(pools.keys().next().value);
    return value;
  }

  async function submit(postValue, walletValue, coinId = MAIN_COIN) {
    const coin = await findCoin(coinId);
    if (!coin) throw notFound();
    const post = normalizePost(postValue), wallet = normalizeWallet(walletValue), tweetId = tweetIdOf(post);
    if (await one('SELECT id FROM submissions WHERE coin=? AND tweet_id=?', [coin.id, tweetId])) throw conflict('That post has already been submitted.');
    if (await used(coin.id, 'wallet', wallet) >= maxPerAccount) throw conflict('That wallet has already been rewarded.');
    const tweet = await verify(post, { ticker: coin.ticker, coinAddress: coin.coinAddress });
    if (await used(coin.id, 'author', tweet.author) >= maxPerAccount) throw new Rejection(`@${tweet.author} has already been rewarded.`);
    const id = randomUUID();
    try {
      await run("INSERT INTO submissions(id,coin,post,tweet_id,author,author_name,avatar_url,wallet,tweet_text,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,'queued',?)", [id, coin.id, post, tweetId, tweet.author, tweet.name || tweet.author, tweet.avatar || null, wallet, tweet.text, clock()]);
    } catch (error) {
      if (/UNIQUE/i.test(error.message)) throw conflict('That post has already been submitted.');
      throw error;
    }
    await bump();
    return record(await one('SELECT * FROM submissions WHERE id=?', [id]));
  }

  // Every open page asks for the same data every few seconds. Answers are shared for READ_CACHE_MS, and any change
  // made by this server clears them at once, so hundreds of viewers cost about as much as one.
  const reads = new Map();
  async function cached(key, compute) {
    const hit = reads.get(key);
    if (hit && clock() - hit.at < READ_CACHE_MS) return hit.value;
    const value = compute();
    reads.set(key, { at: clock(), value });
    if (reads.size > 1000) reads.delete(reads.keys().next().value);
    // A failed read is not kept, so the next request tries again.
    value.catch(() => { if (reads.get(key)?.value === value) reads.delete(key); });
    return value;
  }
  const state = (requestedPage = 0, coinId = MAIN_COIN) => cached(`state:${coinId}:${requestedPage}`, () => readState(requestedPage, coinId));
  const coins = () => cached('coins', readCoins);

  async function readState(requestedPage, coinId) {
    const coin = await findCoin(coinId);
    if (!coin) throw notFound();
    const total = (await one('SELECT count(*) AS n FROM submissions WHERE coin=?', [coin.id])).n;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), page = Math.min(pages - 1, Math.max(0, requestedPage));
    const rows = await all('SELECT * FROM submissions WHERE coin=? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', [coin.id, PAGE_SIZE, page * PAGE_SIZE]);
    const latest = await one("SELECT * FROM submissions WHERE coin=? AND status='sent' ORDER BY paid_at DESC LIMIT 1", [coin.id]);
    const totals = await one("SELECT count(*) AS paid, coalesce(sum(amount_cents),0) AS cents, coalesce(sum(lamports),0) AS lamports, count(DISTINCT wallet) AS wallets, (SELECT count(*) FROM submissions WHERE coin=?1 AND status IN ('queued','sending')) AS queued FROM submissions WHERE coin=?1 AND status='sent'", [coin.id]);
    return {
      serverNow: clock(), total, page, pages, pageSize: PAGE_SIZE, records: rows.map(record), coin: publicCoin(coin), feePoolLamports: await poolOf(coin),
      latestPayout: latest ? record(latest) : null, cluster, paidCount: totals.paid, paidCents: totals.cents, paidLamports: totals.lamports, walletsPaid: totals.wallets, queued: totals.queued,
      revision: Number((await one("SELECT value FROM metadata WHERE key='revision'")).value),
    };
  }

  // Every live coin with its payout totals; the site's own coin first, then the newest launches.
  async function readCoins() {
    const rows = await all("SELECT * FROM coins WHERE status='live' ORDER BY launched_at DESC LIMIT 500");
    const stats = new Map((await all("SELECT coin, sum(status='sent') AS paid, coalesce(sum(CASE WHEN status='sent' THEN lamports END),0) AS lamports, sum(status IN ('queued','sending')) AS queued FROM submissions GROUP BY coin")).map(row => [row.coin, row]));
    const list = [await mainInfo(), ...rows.map(coinInfo)];
    return {
      cluster, revision: Number((await one("SELECT value FROM metadata WHERE key='revision'")).value),
      coins: list.map(coin => ({ ...publicCoin(coin), paidCount: Number(stats.get(coin.id)?.paid || 0), paidLamports: Number(stats.get(coin.id)?.lamports || 0), queued: Number(stats.get(coin.id)?.queued || 0) })),
    };
  }

  // Launch bookkeeping. The wallet index is allocated here so two launches can never share a payout wallet.
  async function reserveCoin(coin, addressFor) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const index = (await one('SELECT coalesce(max(wallet_index),0)+1 AS next FROM coins')).next;
      try {
        await run("INSERT INTO coins(id,ticker,name,description,image,twitter,telegram,website,launcher,wallet_index,payout_wallet,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?)",
          [coin.id, coin.ticker, coin.name, coin.description || null, coin.image || null, coin.twitter || null, coin.telegram || null, coin.website || null, coin.launcher, index, addressFor(index), clock()]);
        return index;
      } catch (error) { if (!/UNIQUE/i.test(error.message) || /coins\.id/i.test(error.message)) throw error; }
    }
    throw new Error('Could not allocate a payout wallet. Please try again.');
  }
  // A ticker is taken by the site's coin, a live coin, or a launch still in progress.
  const tickerTaken = async symbol => symbol.toUpperCase() === String(mainCoin.ticker || '').toUpperCase()
    || Boolean(await one("SELECT 1 FROM coins WHERE upper(ticker)=? AND (status='live' OR (status='pending' AND created_at>?))", [symbol.toUpperCase(), clock() - 15 * 60000]));
  const coinRow = async id => (await one('SELECT * FROM coins WHERE id=?', [String(id)])) || null;
  const hiddenCoins = () => all("SELECT * FROM coins WHERE status='hidden' ORDER BY launched_at DESC");
  const pendingCoins = () =>all("SELECT * FROM coins WHERE status='pending' ORDER BY created_at LIMIT 20");
  async function setCoinStatus(id, status, signature = null) {
    if (await run("UPDATE coins SET status=?, signature=coalesce(?,signature), launched_at=CASE WHEN ?='live' THEN ? ELSE launched_at END WHERE id=? AND status='pending'", [status, signature, status, clock(), id])) await bump();
  }
  // Takes a live coin off the site (its page, the list and its payouts) or brings it back. Its wallet and fees stay untouched.
  async function setCoinHidden(id, hidden) {
    const changed = await run('UPDATE coins SET status=? WHERE id=? AND status=?', hidden ? ['hidden', id, 'live'] : ['live', id, 'hidden']);
    if (changed) await bump();
    return Boolean(changed);
  }
  const setting = async key => (await one('SELECT value FROM metadata WHERE key=?', [key]))?.value ?? null;
  async function setMainCoinAddress(address) {
    const value = normalizeWallet(address);
    await saveSetting(MAIN_CA_KEY, value);
    await bump();
    return value;
  }
  const saveSetting = (key, value) => run('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]);

  // Settles payouts whose outcome was unknown (timeout or crash) using the saved signature.
  async function reconcile() {
    const stuck = await all("SELECT * FROM submissions WHERE status='sending' AND signature IS NOT NULL");
    for (const row of stuck) {
      const coin = await findCoin(row.coin), coinPayer = coin && payerFor(coin);
      if (!coinPayer) continue;
      const result = await coinPayer.status(row.signature, row.last_valid_height);
      if (result === 'confirmed') await run("UPDATE submissions SET status='sent', paid_at=?, note=NULL WHERE id=? AND status='sending'", [clock(), row.id]);
      else if (result === 'failed') await run("UPDATE submissions SET status='failed', note='Transaction failed on-chain.' WHERE id=? AND status='sending'", [row.id]);
      // It never landed, so it is safe to try again, but not forever.
      else if (result === 'expired') await run(`UPDATE submissions SET status=CASE WHEN attempts>=${MAX_EXPIRED - 1} THEN 'failed' ELSE 'queued' END,
        note=CASE WHEN attempts>=${MAX_EXPIRED - 1} THEN 'The network kept dropping this payment.' ELSE note END,
        attempts=attempts+1, signature=NULL, last_valid_height=NULL WHERE id=? AND status='sending'`, [row.id]);
      if (result !== 'pending') await bump();
    }
    // A claim that never got as far as signing is safe to retry.
    if (await run("UPDATE submissions SET status='queued' WHERE status='sending' AND signature IS NULL AND claimed_at<?", [clock() - 120000])) await bump();
  }

  const claims = new Map();
  async function topUp(coin) {
    if (!claimFees || clock() - (claims.get(coin.id) || 0) < CLAIM_EVERY) return false;
    claims.set(coin.id, clock());
    try { const claimed = await claimFees(coin); if (claimed) pools.delete(coin.id); return claimed; }
    catch (error) { log.error?.(`Fee claim for $${coin.ticker} failed:`, error.message); return false; }
  }

  // The SOL price is shared by every coin's payouts in a run.
  let priceCache = null;
  async function solPrice() {
    if (priceCache && clock() - priceCache.at < PRICE_TTL) return priceCache.value;
    const value = await price();
    priceCache = { at: clock(), value };
    return value;
  }
  // A coin that cannot pay right now steps aside for a while, so it never holds up the others.
  const later = (key, ms) => run('UPDATE metadata SET value=? WHERE key=?', [String(clock() + ms), key]);

  // Pays at most one queued submission for this coin, spaced by payoutIntervalMs across all server instances.
  async function payNext(coin) {
    const coinPayer = payerFor(coin);
    if (!coinPayer) return;
    const now = clock(), key = payoutKey(coin.id);
    const next = await one("SELECT * FROM submissions WHERE coin=? AND status='queued' ORDER BY created_at, id LIMIT 1", [coin.id]);
    if (!next) return;
    await run("INSERT OR IGNORE INTO metadata VALUES(?, '0')", [key]);
    if (!await run('UPDATE metadata SET value=? WHERE key=? AND CAST(value AS INTEGER)<=?', [String(now + payoutIntervalMs), key, now])) return;
    const paid = await one("SELECT (SELECT count(*) FROM submissions WHERE coin=?1 AND status IN ('sending','sent') AND author=?2) AS author, (SELECT count(*) FROM submissions WHERE coin=?1 AND status IN ('sending','sent') AND wallet=?3) AS wallet", [coin.id, next.author, next.wallet]);
    if (paid.author >= maxPerAccount || paid.wallet >= maxPerAccount) {
      await run("UPDATE submissions SET status='failed', note='Already rewarded.' WHERE id=? AND status='queued'", [next.id]); await bump(); return;
    }
    // The post is checked again right before paying: deleted, or edited to drop the coin or the wallet, means no payout.
    // If X cannot be reached, the entry waits instead of being rejected.
    if (recheck) {
      try { await recheck(next, coin); }
      catch (error) {
        if (!(error instanceof Rejection)) { log.warn?.(`Could not recheck a $${coin.ticker} post before paying:`, error.message); await later(key, RECHECK_WAIT); return; }
        await run("UPDATE submissions SET status='failed', note=? WHERE id=? AND status='queued'", [error.message.slice(0, 200), next.id]); await bump(); return;
      }
    }
    let cents = next.amount_cents;
    if (cents === null) {
      const history = await one('SELECT count(*) AS n, coalesce(max(amount_cents),0) AS top FROM submissions WHERE coin=? AND amount_cents IS NOT NULL', [coin.id]);
      cents = fixedCents || payoutCents(history.n, history.top, randomInt, tiers, tierSize);
    }
    const spent = (await one("SELECT coalesce(sum(amount_cents),0) AS cents FROM submissions WHERE coin=? AND status IN ('sending','sent') AND coalesce(paid_at,created_at)>?", [coin.id, now - 86400000])).cents;
    if (spent + cents > dailyCapCents) { log.warn?.(`Daily payout cap reached for $${coin.ticker}; payouts paused.`); await later(key, CAP_WAIT); return; }
    const usd = await solPrice(), lamports = lamportsFor(cents, usd);
    // A launched coin's wallet is only ever funded by its creator fees, so it pays out as fast as fees come in.
    if (!await coinPayer.canAfford(lamports) && !(await topUp(coin) && await coinPayer.canAfford(lamports))) {
      if (!coin.launched) log.warn?.('Payout wallet balance is too low; payouts paused.');
      await later(key, FUNDS_WAIT);
      return;
    }
    if (!await run("UPDATE submissions SET status='sending', amount_cents=?, lamports=?, sol_price=?, claimed_at=? WHERE id=? AND status='queued'", [cents, lamports, usd, clock(), next.id])) return;
    await bump();
    const transfer = await coinPayer.prepare(next.wallet, lamports);
    // Only broadcast if this instance still owns the claim.
    if (!await run("UPDATE submissions SET signature=?, last_valid_height=? WHERE id=? AND status='sending' AND signature IS NULL", [transfer.signature, transfer.lastValidBlockHeight, next.id])) return;
    let outcome;
    try { outcome = await transfer.send(); }
    catch (error) {
      // The network refused it, so it never landed: retry later, and give up after 3 refusals so one bad entry cannot block the queue.
      if (error.rejected) { await run("UPDATE submissions SET status=CASE WHEN attempts>=2 THEN 'failed' ELSE 'queued' END, note=CASE WHEN attempts>=2 THEN 'Solana refused this payment three times.' ELSE ? END, attempts=attempts+1, signature=NULL, last_valid_height=NULL WHERE id=?", [String(error.message).slice(0, 200), next.id]); await bump(); }
      log.error?.('Payout send failed:', error.message);
      return; // Otherwise left as 'sending'; reconcile() settles it from the signature.
    }
    if (outcome === 'confirmed') await run("UPDATE submissions SET status='sent', paid_at=?, note=NULL WHERE id=?", [clock(), next.id]);
    else await run("UPDATE submissions SET status='failed', note='Transaction failed on-chain.' WHERE id=?", [next.id]);
    pools.delete(coin.id);
    await bump();
  }

  // Each run pays one entry for each of up to PARALLEL_COINS coins at once: every coin has its own wallet, so their
  // payouts never conflict. Coins take turns, least recently served first, and only coins that are due are picked.
  let running = false;
  async function processPayouts() {
    if (!payoutsEnabled || running) return;
    running = true;
    try {
      await reconcile();
      const due = await all(`SELECT s.coin, coalesce(max(CAST(m.value AS INTEGER)),0) AS due FROM submissions s
        LEFT JOIN metadata m ON m.key=CASE WHEN s.coin='${MAIN_COIN}' THEN 'next_payout_at' ELSE 'next_payout_at:'||s.coin END
        WHERE s.status='queued' GROUP BY s.coin HAVING due<=? ORDER BY due, min(s.created_at) LIMIT ?`, [clock(), PARALLEL_COINS]);
      await Promise.all(due.map(async ({ coin: id }) => {
        const coin = await findCoin(id);
        if (coin) await payNext(coin).catch(error => log.error?.(`Payout processing error for $${coin.ticker}:`, error.message));
      }));
    } catch (error) {
      log.error?.('Payout processing error:', error.message);
    } finally { running = false; }
  }

  return { submit, state, coins, reserveCoin, tickerTaken, coinRow, pendingCoins, hiddenCoins, setCoinStatus, setCoinHidden, setMainCoinAddress, setting, saveSetting, processPayouts, close: () => db.close() };
}
