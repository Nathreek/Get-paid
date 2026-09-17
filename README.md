# GET PAID dashboard

Black-and-white responsive dashboard with a GP logo, shared submission list and one cycling name pill. No installation dependencies.

## Run locally

Requires Node.js 24.19 or newer with built-in node:sqlite.

```sh
node server.mjs
```

Open http://127.0.0.1:4173. The default address is restricted to this computer. The complete Node server is required; dist/ alone is no longer a static-only deployment.

```sh
node --test tests/*.test.mjs
node tests/load-500.mjs
```

## Shared submissions and timing

- Visitors using the same server see one shared list and featured name.
- Entries persist in data/submissions.sqlite using SQLite WAL. There is no two-entry or 100-entry limit. The interface displays 25 entries per page.
- Each submission waits a random 5–25 seconds, then appears in the list as Pending. The backend enforces another 60 seconds before top-box eligibility.
- The top pill changes every 6–12 seconds, observed on each client's next 4–6 second poll. Eligible, never-shown submissions take priority in order. Afterward, sample names alternate with previously featured submissions.
- One minute is the minimum eligibility wait, not a guaranteed appearance time. A burst of 500 eligible names needs roughly 50–100 minutes of active rotation for every first appearance.
- Sent means a browser acknowledged displaying the name. It is not evidence of payment, verification, or account ownership.
- Deadlines and Sent status survive refresh and restart. Hidden tabs stop polling and reconnect on return.
- Guests receive an HttpOnly cookie. Only the creating guest can remove an entry. Clearing cookies loses removal permission. This is not account authentication.
- Old browser-local records import in batches, retaining the original browser copy. Imports receive fresh server deadlines. Large imports may need another visit after the import rate limit resets.
- Invalid punctuation produces a specific error. Duplicate post/handle pairs are rejected. A guest can submit up to 60 entries per minute.

## Configure and integrate

- dist/config.js: set coinAddress when available. It populates the CA line and Buy dialog and enables Copy CA. The purchase URL field is reserved for later integration.
- dist/profiles.js: replace resolveDisplayName(handle) with a server-side X profile integration. Current names are mocked/local aliases. Keep credentials on the backend.
- Bot verification, coin ownership checks, X Money and $PAID payouts are not implemented. How it works describes the planned payment flow.
- The GP image is assets/gp-monogram.png, generated from the supplied lettering reference. The original remains assets/gp-logo.png.

## Hosting

The local 500-client test passed; see CAPACITY-REPORT.md for evidence and limits. Public hosting has not been configured or verified.

### Vercel (small-data preview)

This repository includes a Vercel serverless adapter. It is suitable for a small preview or demo only: SQLite is stored in `/tmp`, so data can be cleared when Vercel recycles the function, and concurrent instances do not share one database. Connect the GitHub repository to Vercel and deploy with the default settings. Do not use this deployment for durable submissions.

Use one Node process, a persistent local disk and an HTTPS reverse proxy. Configure PORT, HOST, DB_PATH (persistent writable database path) and SECURE_COOKIES=true on HTTPS. Preserve the public Host and Origin headers through the proxy. Never expose data/ as static content.

Do not run independent replicas with separate SQLite files or deploy onto ephemeral serverless storage. Horizontal scaling requires a shared database and coordinated scheduler.

Before launch, test the actual host at expected traffic, configure process restart, health checks (/healthz), backups, monitoring and edge abuse protection. Per-cookie rate limiting is basic and can be bypassed with new sessions. No paid service or public deployment was activated.

For a consistent backup, stop the server gracefully and copy the entire data directory before restarting. Keep the database and any WAL files together. The project ZIP excludes live submissions.
