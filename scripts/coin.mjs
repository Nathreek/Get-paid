// Hide a launched coin from the site, or bring it back. Uses the database from .env (or the environment).
//   node scripts/coin.mjs list
//   node scripts/coin.mjs hide <mint address>
//   node scripts/coin.mjs show <mint address>
//   node scripts/coin.mjs set-ca <contract address>   the site's own coin (GET-PAID): shows its CA live, no redeploy
// A hidden coin disappears from /coins, its page returns "not found", and its queue stops paying out.
// Its payout wallet and creator fees are untouched, so showing it again resumes everything.
import { fileURLToPath } from 'node:url';
import { createStore } from '../store.mjs';
import { loadLocalEnv } from '../app.mjs';

loadLocalEnv();
const [action, id] = process.argv.slice(2);
const url = process.env.TURSO_DATABASE_URL || 'file:' + fileURLToPath(new URL('../data/get-paid.db', import.meta.url));
const store = await createStore({ url, authToken: process.env.TURSO_AUTH_TOKEN, verify: null, price: null, log: {} });
try {
  if (action === 'list') {
    for (const coin of (await store.coins()).coins.filter(coin => coin.id !== 'main')) console.log(`live    $${coin.ticker.padEnd(10)} ${coin.id}  wallet ${coin.payoutWallet}`);
    for (const row of await store.hiddenCoins()) console.log(`hidden  $${row.ticker.padEnd(10)} ${row.id}  wallet ${row.payout_wallet}`);
  } else if (action === 'set-ca' && id) {
    console.log(`GET-PAID's contract address is now ${await store.setMainCoinAddress(id)}. The site shows it within a few seconds.`);
  } else if ((action === 'hide' || action === 'show') && id) {
    const changed = await store.setCoinHidden(id, action === 'hide');
    const row = await store.coinRow(id);
    console.log(row ? `$${row.ticker} is now ${row.status}${changed ? '' : ' (no change)'}.` : 'No coin with that address.');
  } else {
    console.log('Usage: node scripts/coin.mjs list | hide <mint> | show <mint> | set-ca <contract address>');
    process.exitCode = 1;
  }
} finally { store.close(); }
