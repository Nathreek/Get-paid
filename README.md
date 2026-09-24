# GET-PAID.XYZ

People post about the coin on X, submit the post link and their Solana wallet, and are paid in SOL automatically once a bot approves the post.

## How it works

1. **Submit.** A visitor pastes an X post link and a Solana wallet address.
2. **Check.** The server reads the public post through X's free oEmbed endpoint (fxtwitter as fallback). The post must mention `$TICKER` or the coin address. gpt-oss (Groq) then decides whether it promotes the coin positively. Rejected posts are not stored; the visitor sees the reason.
3. **Queue.** Approved posts appear in the reveal room as *Approved · queued*.
4. **Pay.** Queued entries are paid oldest first, one every `PAYOUT_INTERVAL_SECONDS`. The dollar amount follows the tiers below and is converted to SOL at the live price (Jupiter, CoinGecko fallback). Each row links to its Solscan transaction, and the top pill shows the latest payout.

By default, amounts rise from $5 to $30 across the first 30 payouts, then stay at about $30.

These are the defaults. Set `PAYOUT_FIXED_USD` to pay everyone the same amount, or change `PAYOUT_TIERS` / `PAYOUT_TIER_SIZE` (see `.env.example`). Amounts never decrease. Each post, wallet and X account can be rewarded once (`MAX_PAYOUTS_PER_ACCOUNT`).

## Safety

- Nothing is sent until `PAYOUTS_ENABLED=true` and `PAYOUT_PRIVATE_KEY` is set. Use a dedicated hot wallet funded with only what you plan to pay out.
- `MAX_DAILY_PAYOUT_USD` pauses payouts once the last 24 hours reach the cap. Payouts also pause if the wallet balance is too low.
- Each transaction's signature is saved before it is broadcast. If a send times out or the server stops, the next run checks that signature on-chain and marks it paid, or requeues it once its blockhash has expired — it is never sent twice.
- Submissions are rate-limited to 5 per minute per IP.

## Settings

- `dist/config.js` — `ticker` (without `$`) and `coinAddress`. Submissions are refused until `ticker` is set.
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
