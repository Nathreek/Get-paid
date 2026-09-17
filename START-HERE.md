# GET PAID — handoff guide

## Run on your computer

1. Extract the ZIP into a folder. Do not run files from inside the ZIP.
2. Install Node.js 24.19 or newer if it is not already installed. This project was tested with Node 24.19.0.
3. Open a terminal in the extracted folder containing `server.mjs` and `package.json`.
4. Run `node server.mjs`. No package installation or build step is required.
5. Open **http://127.0.0.1:4173/** in your browser. Keep the terminal open while using the site. Press Ctrl+C to stop it.

If port 4173 is already in use, choose another port. In Windows PowerShell:

```powershell
$env:PORT = '4174'
node server.mjs
```

Then open http://127.0.0.1:4174/. If Node reports that `node:sqlite` is unavailable, check `node --version` and install the required version.

## What is included

The complete frontend, Node server, SQLite storage layer, logo assets, tests, and capacity reports. The public treasury wallet is already set to:

`7CVZZLWaerL6b42Bo5kkpKnEEGXYf8MLAUVAiNLymqiv`

The coin contract address is still a placeholder. Configure it in `dist/config.js`. The treasury wallet is separate from the coin contract address; its header markup is in `dist/index.html`.

Existing live submissions are excluded. The first run creates a new `data/submissions.sqlite` database automatically. Everyone using the same running server shares its list. Separate computers running separate copies have separate databases.

## Deploy this version

Use a host capable of running a long-lived Node process with a persistent writable disk. The start command is `node server.mjs`. There is no build command or dependency installation requirement.

Configure these environment variables through the hosting dashboard or service configuration:

| Variable | Value / purpose |
| --- | --- |
| `HOST` | `0.0.0.0` when the host requires the app to listen on its network interface; otherwise bind appropriately behind your proxy. |
| `PORT` | The port assigned by the host; defaults to `4173`. |
| `DB_PATH` | Full path on a mounted persistent disk, e.g. `/var/lib/get-paid/submissions.sqlite`. The process must have write permission. |
| `SECURE_COOKIES` | `true` for a public HTTPS deployment. Leave unset for local HTTP. |

The server reads environment variables; it does not automatically load a `.env` file.

Put HTTPS in front of the app, preserve the public Host and Origin headers, and route both the page and `/api/*` to the same Node service. Use `/healthz` for health checks. Configure automatic restarts and database backups.

Run one app instance with this SQLite implementation. Do not upload only `dist/` to a static host, put the database on ephemeral storage, or start independent replicas with separate databases. A different architecture is needed for horizontal scaling.

Before public launch, run the tests and verify submissions, refresh/restart persistence, the Buy dialog, and HTTPS cookies on the actual host. Add hosting-level traffic protection and monitoring, and load-test that deployment. The included 500-client result is a short local synthetic test, not a guarantee of hosted capacity.

## Integration status

Display names use a mocked/local mapping in `dist/profiles.js`. Real X account lookup, tweet verification, coin ownership checks and X Money/$PAID payments are not connected. `Sent` currently means the name appeared in the top box, not that money was sent. The displayed dollar amount is illustrative.

## Tests and further details

```sh
node --test tests/*.test.mjs
node tests/load-500.mjs
```

The load test uses a temporary database. See `README.md` for timing and ownership behavior and `CAPACITY-REPORT.md` for measured results and limitations. `VERIFICATION.md` includes historical UI checks.
