# GET-PAID

People post about the coin on X, submit the post link and their Solana wallet, and are paid in SOL automatically once a bot approves the post.

## How it works

1. **Submit.** A visitor pastes an X post link and a Solana wallet address.
2. **Check.** The server reads the public post through X's free oEmbed endpoint (fxtwitter as fallback). The post must mention `$TICKER` or the coin address. gpt-oss (Groq) then decides whether it promotes the coin positively. Rejected posts are not stored; the visitor sees the reason.
3. **Queue.** Approved posts appear in the reveal room as *Approved · queued*.
4. **Pay.** Queued entries are paid oldest first, one every `PAYOUT_INTERVAL_SECONDS`. The dollar amount follows the tiers below and is converted to SOL at the live price (Jupiter, CoinGecko fallback). Each row links to its Solscan transaction, and the top pill shows the latest payout.

By default, amounts rise from $5 to $30 across the first 30 payouts, then stay at about $30.

These are the defaults. Set `PAYOUT_FIXED_USD` to pay everyone the same amount, or change `PAYOUT_TIERS` / `PAYOUT_TIER_SIZE` (see `.env.example`). Amounts never decrease. Each post, wallet and X account can be rewarded once (`MAX_PAYOUTS_PER_ACCOUNT`).

## Coin launches

Anyone can launch a coin on pump.fun from `/launch`. Each launched coin gets its own shill campaign, paid from its own creator fees.

1. **Launch.** The launcher fills in the name, ticker, image and links, and optionally a first buy. The image and metadata go to IPFS (Pinata), and the server builds the pump.fun `create_v2` transaction. The launcher's wallet signs and pays for it.
2. **Fees are locked to the coin.** The coin's creator is a payout wallet made for that coin (wallet #i, derived from `MASTER_SEED`), not the launcher. Every creator fee goes to that wallet, and only the server holds its key. The mint key signs the transaction on the server and is then thrown away.
3. **Go live.** Once the bonding curve exists on-chain with that wallet as creator, the coin is listed at `/coins` and gets its own page at `/coin/<mint>`. Launches whose tab was closed before confirming are settled from the chain; ones that never land are marked abandoned after 15 minutes.
4. **Shill and pay.** Coin pages work like the main page, scoped to that coin: posts must mention its ticker or address, and each coin has its own queue, reveal room, totals, daily cap and one-reward-per-account limit. Payouts come from the coin's wallet. When it runs low, the server collects the coin's creator fees from pump.fun (bonding curve and PumpSwap), at most every 5 minutes. The main payout wallet pays that network fee if it is set. A coin pays out only as fast as its fees come in.

A launch with a first buy is too large for a plain Solana transaction, so the accounts every launch shares go in an address lookup table. The main payout wallet creates it once (about 0.006 SOL), on the first launch with a first buy; until then, first buys show a message instead.

To take a coin off the site (spam, tests), run `node scripts/coin.mjs hide <mint>` with the production database in `.env`; `show <mint>` brings it back and `list` shows them all. Its wallet and fees are untouched.

Launched coin wallets are never reused. The database stores only their public address and index; keys are derived when needed.

## Safety

- Nothing is sent until `PAYOUTS_ENABLED=true` and `PAYOUT_PRIVATE_KEY` is set. Use a dedicated hot wallet funded with only what you plan to pay out.
- If the site's own coin is launched on pump.fun from the payout wallet, its creator rewards are collected into that wallet automatically whenever it runs low. Keep ~0.005 SOL in it for the network fee.
- `MAX_DAILY_PAYOUT_USD` pauses payouts once the last 24 hours reach the cap. Payouts also pause if the wallet balance is too low.
- Each transaction's signature is saved before it is broadcast. If a send times out or the server stops, the next run checks that signature on-chain and marks it paid, or requeues it once its blockhash has expired — it is never sent twice.
- Submissions are rate-limited to 5 per minute per IP; launches to 3.
- When the main payout wallet pays for a coin's fee claim, the coin repays it in the same transaction (network fee and account rent), so claims can never drain the main wallet.
- `MASTER_SEED` controls every launched coin's fees. Keep it only in the host's environment variables, with an offline backup.

## Settings

- `dist/config.js` — `ticker` (without `$`) and `coinAddress`. Submissions are refused until `ticker` is set.
- When the coin launches, set its contract address live with `node scripts/coin.mjs set-ca <address>` (production database in `.env`). The site shows it within seconds, open pages included, and posts may mention the address instead of the ticker. No redeploy needed; it overrides `coinAddress` in `config.js`.
- Environment variables — see `.env.example`. Locally, copy it to `.env`.

## Run locally

Requires Node.js 24.

```sh
npm install
node server.mjs      # http://127.0.0.1:4173
npm test
```

Without `TURSO_DATABASE_URL`, data is stored in `data/get-paid.db`. A local server also runs the payout queue every 15 seconds.

## Deploy on Vercel

1. Create a free database at turso.tech; copy its URL and an auth token.
2. Create a free API key at console.groq.com.
3. In Vercel → Project → Settings → Environment Variables, add the variables from `.env.example`.
4. Push to GitHub; Vercel redeploys.

On Vercel, the payout queue runs while visitors have the page open (each page poll triggers it). With nobody on the site, queued payouts wait until the next visit.

`/healthz` returns `{"status":"ok"}` for uptime checks.
