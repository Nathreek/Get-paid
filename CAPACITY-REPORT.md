# Capacity and verification — 17 September 2026

## Target: approximately 500 simultaneous visitors

The independent-process local test opened fresh connections for 500 virtual visitors against the real SQLite-backed server:

| Measure | Result |
| --- | --- |
| Peak concurrent requests | 500 |
| Requests completed | 4,500 / 4,500 |
| Failed clients | 0 |
| Persisted submissions | 500 |
| Elapsed time | 2.179 seconds |
| Requests per second | 2,065 |
| 95th percentile latency | 407 ms |
| 99th percentile latency | 455 ms |
| Server memory observed | 73 MB |

Raw result: LOAD-TEST-500.json. Reproduce with node tests/load-500.mjs. This uses an isolated temporary database and does not modify the live list.

This was a short synthetic Windows-loopback burst, not 500 real browsers or a guarantee of uptime. Public networking, TLS, hosting quotas, sustained traffic, abuse and provider outages were not covered. Hosted load testing is still required before launch.

## Earlier 2,000-client experiments

Before the target was reduced, the same-process server/load-generator cold-connection test failed with connection refusals: 232 of 2,000 clients completed, with 1,392 of 12,000 requests completed. Increasing the backlog and running outside the sandbox did not resolve that result.

A warmed-connection variant completed 12,000 requests and persisted 2,000 submissions with no client failures (p95 1,418 ms). This does not cancel the cold-connection failures or establish production capacity for 2,000 people.

Preserved evidence: LOAD-TEST-initial.json, LOAD-TEST.json, LOAD-TEST-unrestricted.json, LOAD-TEST-warm.json. The final 500-client test separates the server and load generator into independent processes and uses fresh connections.

## Correctness checks

All 15 automated tests passed: validation, legacy records without truncation, shared pagination, guest ownership, persistent database reopen, exact one-minute eligibility, displayed-name acknowledgment, cross-origin mutation rejection, rate limits and static-file protections.

Browser checks confirmed specific feedback for RTTWE!, a third distinct submission, queued/Pending/Sent states, names appearing in the single top pill, and all three entries surviving server restart.

No X verification, purchases or payouts were performed. Display names remain local aliases. Sent tracks top-box display only.
