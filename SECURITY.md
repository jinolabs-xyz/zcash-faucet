# Security

This is a hot-wallet faucet on a public box. The wallet holds real spending
keys (testnet coins, but the operational lessons transfer), strangers can hit
every endpoint, and the box mines and moves funds unattended. This file
records the standing posture and what the hardening pass (issue #19) reviewed
and changed. It is a working document, not a compliance artifact.

## Threat model, in one paragraph

Nothing on this box is worth a targeted attack. The realistic adversaries are
drain bots (claim faster than the faucet refills), abuse amplifiers (use the
faucet as someone else's load generator), and drive-by scanner findings. The
design answer is layered: browser PoW with adaptive difficulty, a per-address
and per-IP cooldown, a daily cap enforced atomically in SQLite, a serialized
send queue, and a reserve refill loop. No layer trusts another: the load
tests (issue #17) prove solving every challenge honestly still cannot pass
the cap.

## What the #19 pass reviewed

**Input validation on every route.** All request bodies go through zod
schemas, addresses go through the byte-accurate validator (bech32m/bech32
checksum decode plus version and payload rules, since #587dd58), and query
params are validated before use. The two POST routes reject unknown shapes
with a 400 before touching any subsystem. Nothing interpolates request data
into shell commands, SQL (parameterized throughout), or file paths.

**Response headers.** Caddy sets the transport-level headers at the proxy
(HSTS, nosniff, frame-deny, referrer policy, Server stripped, see
`deploy/z3/Caddyfile`). The app now sets nosniff, frame-deny and referrer
policy itself as well, so a directly reached :3000 is not naked. HSTS stays
proxy-only on purpose: the app cannot know whether TLS actually fronts it.

**Secrets and logs.** `RATE_LIMIT_SALT` signs PoW challenges and fingerprints
IPs, and is never logged or returned. Generated throwaway accounts return
their secret to the requester once and are neither stored nor logged, by
design. The zallet RPC password lives in `faucet.env` (root, 600) and reaches
the app via environment. The backup passphrase is passed to gpg on a file
descriptor, never argv or stdin. Grepped the tree for salt/password/secret/
key/mnemonic near logging calls: nothing reaches a log.

**What is public on purpose.** `/api/status` exposes the balance, queue depth
and reserve state, and `/api/ready` exposes why the faucet cannot drip. That
is an transparency decision, not an oversight: users deserve to know whether
the faucet is honest about being empty. The metrics file stays off HTTP
entirely (`deploy/z3/OBSERVABILITY.md`).

## Dependency gates in CI

The `audit` job fails the build on any high or critical npm advisory and any
RustSec advisory against the miner's lockfile. Lows are printed but do not
gate. As of this pass that gate is green because:

- `next` is at 15.5.22 and `postcss`/`sharp` are held at patched versions via
  `overrides` in package.json (the app never uses next's image pipeline, the
  override just keeps the vulnerable copies out of the tree).
- The remaining low is the `elliptic` chain under `@bitgo/utxo-lib`, used
  only for transparent throwaway-account generation on testnet. Accepted: the
  advisory is a timing-channel class issue in a code path that signs nothing
  valuable, and the fix upstream is a major bump we take when BitGo ships it.

Accepted-risk entries above should be re-argued, not inherited, whenever the
gate next goes red.

## Reporting

This is a testnet toy with real lessons, not a bug-bounty target. If you find
something, open a GitHub issue, or use a private channel to the maintainer if
it is genuinely sensitive.
