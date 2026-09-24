import { createClient } from '@libsql/client';
import { randomUUID, randomInt } from 'node:crypto';
import { normalizePost, normalizeWallet, tweetIdOf } from './dist/model.js';
import { Rejection } from './verify.mjs';
import { lamportsFor } from './payout.mjs';

export const PAGE_SIZE = 25;
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

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS submissions(
    id TEXT PRIMARY KEY, post TEXT NOT NULL, tweet_id TEXT NOT NULL, author TEXT NOT NULL, wallet TEXT NOT NULL, tweet_text TEXT NOT NULL,
    status TEXT NOT NULL, note TEXT, amount_cents INTEGER, lamports INTEGER, sol_price REAL, signature TEXT, last_valid_height INTEGER,
    created_at INTEGER NOT NULL, claimed_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, paid_at INTEGER)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS submissions_tweet ON submissions(tweet_id)',
  'CREATE INDEX IF NOT EXISTS submissions_created ON submissions(created_at DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS submissions_status ON submissions(status, created_at)',
  'CREATE INDEX IF NOT EXISTS submissions_author ON submissions(author)',
  'CREATE INDEX IF NOT EXISTS submissions_wallet ON submissions(wallet)',
  'CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  "INSERT OR IGNORE INTO metadata VALUES('revision','0'),('next_payout_at','0')",
];

// status: queued → sending → sent (or failed). Rejected posts are never stored.
export async function createStore({ url, authToken, verify, payer = null, price, cluster = 'mainnet', payoutsEnabled = false, payoutIntervalMs = 10000, dailyCapCents = 10000, maxPerAccount = 1, fixedCents = 0, tiers = TIERS, tierSize = TIER_SIZE, clock = Date.now, log = console }) {
  const db = createClient({ url, authToken });
  await db.batch(SCHEMA, 'write');
  // Columns added after launch; existing databases get them on startup.
  const columns = new Set((await db.execute('PRAGMA table_info(submissions)')).rows.map(column => column.name));
  for (const [name, type] of [['author_name', 'TEXT'], ['avatar_url', 'TEXT']]) if (!columns.has(name)) await db.execute(`ALTER TABLE submissions ADD COLUMN ${name} ${type}`);
  const one = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];
  const run = async (sql, args = []) => (await db.execute({ sql, args })).rowsAffected;
  const bump = () => run("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
  const record = row => ({
    id: row.id, post: row.post, author: row.author, name: row.author_name || row.author, avatar: row.avatar_url || null, text: row.tweet_text, wallet: row.wallet, status: row.status, createdAt: row.created_at,
    ...(row.amount_cents === null ? {} : { amountCents: row.amount_cents }),
    ...(row.status === 'sent' ? { signature: row.signature, paidAt: row.paid_at, lamports: row.lamports } : {}),
  });
  const used = async (column, value) => (await one(`SELECT count(*) AS n FROM submissions WHERE ${column}=? AND status!='failed'`, [value])).n;

  async function submit(postValue, walletValue) {
    const post = normalizePost(postValue), wallet = normalizeWallet(walletValue), tweetId = tweetIdOf(post);
    if (await one('SELECT id FROM submissions WHERE tweet_id=?', [tweetId])) throw conflict('That post has already been submitted.');
    if (await used('wallet', wallet) >= maxPerAccount) throw conflict('That wallet has already been rewarded.');
    const tweet = await verify(post);
    if (await used('author', tweet.author) >= maxPerAccount) throw new Rejection(`@${tweet.author} has already been rewarded.`);
    const id = randomUUID();
    try {
      await run("INSERT INTO submissions(id,post,tweet_id,author,author_name,avatar_url,wallet,tweet_text,status,created_at) VALUES(?,?,?,?,?,?,?,?,'queued',?)", [id, post, tweetId, tweet.author, tweet.name || tweet.author, tweet.avatar || null, wallet, tweet.text, clock()]);
    } catch (error) {
      if (/UNIQUE/i.test(error.message)) throw conflict('That post has already been submitted.');
      throw error;
    }
    await bump();
    return record(await one('SELECT * FROM submissions WHERE id=?', [id]));
  }

  async function state(requestedPage = 0) {
    const total = (await one("SELECT count(*) AS n FROM submissions")).n;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), page = Math.min(pages - 1, Math.max(0, requestedPage));
    const rows = (await db.execute({ sql: 'SELECT * FROM submissions ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', args: [PAGE_SIZE, page * PAGE_SIZE] })).rows;
    const latest = await one("SELECT * FROM submissions WHERE status='sent' ORDER BY paid_at DESC LIMIT 1");
    const totals = await one("SELECT count(*) AS paid, coalesce(sum(amount_cents),0) AS cents, coalesce(sum(lamports),0) AS lamports, count(DISTINCT wallet) AS wallets, (SELECT count(*) FROM submissions WHERE status IN ('queued','sending')) AS queued FROM submissions WHERE status='sent'");
    return {
      serverNow: clock(), total, page, pages, pageSize: PAGE_SIZE, records: rows.map(record),
      latestPayout: latest ? record(latest) : null, cluster, paidCount: totals.paid, paidCents: totals.cents, paidLamports: totals.lamports, walletsPaid: totals.wallets, queued: totals.queued,
      revision: Number((await one("SELECT value FROM metadata WHERE key='revision'")).value),
    };
  }

  // Settles payouts whose outcome was unknown (timeout or crash) using the saved signature.
  async function reconcile() {
    const stuck = (await db.execute("SELECT * FROM submissions WHERE status='sending' AND signature IS NOT NULL")).rows;
    for (const row of stuck) {
      const result = await payer.status(row.signature, row.last_valid_height);
      if (result === 'confirmed') await run("UPDATE submissions SET status='sent', paid_at=?, note=NULL WHERE id=? AND status='sending'", [clock(), row.id]);
      else if (result === 'failed') await run("UPDATE submissions SET status='failed', note='Transaction failed on-chain.' WHERE id=? AND status='sending'", [row.id]);
      else if (result === 'expired') await run("UPDATE submissions SET status='queued', signature=NULL, last_valid_height=NULL WHERE id=? AND status='sending'", [row.id]);
      if (result !== 'pending') await bump();
    }
    // A claim that never got as far as signing is safe to retry.
    if (await run("UPDATE submissions SET status='queued' WHERE status='sending' AND signature IS NULL AND claimed_at<?", [clock() - 120000])) await bump();
  }

  // Pays at most one queued submission per call, spaced by payoutIntervalMs across all server instances.
  let running = false;
  async function processPayouts() {
    if (!payoutsEnabled || !payer || running) return;
    running = true;
    try {
      await reconcile();
      const now = clock();
      const next = await one("SELECT * FROM submissions WHERE status='queued' ORDER BY created_at, id LIMIT 1");
      if (!next) return;
      if (!await run("UPDATE metadata SET value=? WHERE key='next_payout_at' AND CAST(value AS INTEGER)<=?", [String(now + payoutIntervalMs), now])) return;
      const paid = await one("SELECT (SELECT count(*) FROM submissions WHERE status IN ('sending','sent') AND author=?) AS author, (SELECT count(*) FROM submissions WHERE status IN ('sending','sent') AND wallet=?) AS wallet", [next.author, next.wallet]);
      if (paid.author >= maxPerAccount || paid.wallet >= maxPerAccount) {
        await run("UPDATE submissions SET status='failed', note='Already rewarded.' WHERE id=? AND status='queued'", [next.id]); await bump(); return;
      }
      let cents = next.amount_cents;
      if (cents === null) {
        const history = await one('SELECT count(*) AS n, coalesce(max(amount_cents),0) AS top FROM submissions WHERE amount_cents IS NOT NULL');
        cents = fixedCents || payoutCents(history.n, history.top, randomInt, tiers, tierSize);
      }
      const spent = (await one("SELECT coalesce(sum(amount_cents),0) AS cents FROM submissions WHERE status IN ('sending','sent') AND coalesce(paid_at,created_at)>?", [now - 86400000])).cents;
      if (spent + cents > dailyCapCents) { log.warn?.('Daily payout cap reached; payouts paused.'); return; }
      const usd = await price(), lamports = lamportsFor(cents, usd);
      if (!await payer.canAfford(lamports)) { log.warn?.('Payout wallet balance is too low; payouts paused.'); return; }
      if (!await run("UPDATE submissions SET status='sending', amount_cents=?, lamports=?, sol_price=?, claimed_at=? WHERE id=? AND status='queued'", [cents, lamports, usd, clock(), next.id])) return;
      await bump();
      const transfer = await payer.prepare(next.wallet, lamports);
      // Only broadcast if this instance still owns the claim.
      if (!await run("UPDATE submissions SET signature=?, last_valid_height=? WHERE id=? AND status='sending' AND signature IS NULL", [transfer.signature, transfer.lastValidBlockHeight, next.id])) return;
      let outcome;
      try { outcome = await transfer.send(); }
      catch (error) {
        // The network refused it, so it never landed: retry later, and give up after 3 refusals so one bad entry cannot block the queue.
        if (error.rejected) { await run("UPDATE submissions SET status=CASE WHEN attempts>=2 THEN 'failed' ELSE 'queued' END, attempts=attempts+1, signature=NULL, last_valid_height=NULL, note=? WHERE id=?", [String(error.message).slice(0, 200), next.id]); await bump(); }
        log.error?.('Payout send failed:', error.message);
        return; // Otherwise left as 'sending'; reconcile() settles it from the signature.
      }
      if (outcome === 'confirmed') await run("UPDATE submissions SET status='sent', paid_at=?, note=NULL WHERE id=?", [clock(), next.id]);
      else await run("UPDATE submissions SET status='failed', note='Transaction failed on-chain.' WHERE id=?", [next.id]);
      await bump();
    } catch (error) {
      log.error?.('Payout processing error:', error.message);
    } finally { running = false; }
  }

  return { submit, state, processPayouts, close: () => db.close() };
}
