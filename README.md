# Zcash Testnet Faucet (TAZ)

A Next.js / TypeScript faucet that dispenses **TAZ** (Zcash testnet coins) to
developers. Uses a **public lightwalletd/Zaino testnet endpoint** as the
backend — no full node to run.

> **2026 context:** `zcashd` reached End-of-Life on **2026-07-18** and every node
> auto-halted. The current stack is the **Z3 unification** (Zebra + Zallet + Zaino).
> This faucet talks to a lightwalletd-compatible gRPC endpoint via a WASM
> light-wallet, so it doesn't depend on the retired `zcashd`.

## Design principles: decentralization & privacy

This is a Zcash tool, so it tries to act like one:

- **No raw PII stored.** Rate-limiting is keyed on a **salted hash** of the IP
  (`lib/privacy.ts`), never the IP itself. Set `RATE_LIMIT_SALT` in prod. The
  claim ledger holds no addresses-to-identity linkage beyond what's needed to
  enforce cooldowns.
- **Configurable, self-hostable backend.** `LIGHTWALLETD_ENDPOINT` takes a list
  with failover. Point it at **your own** Zebra + Zaino/lightwalletd (the Z3
  docker-compose stack) to drop the third-party dependency entirely.
- **Durable ledger on ephemeral hosts.** On a host whose disk is wiped on
  restart (e.g. Render free), local SQLite would reset the rate-limit ledger and
  make the faucet drainable across redeploys. Setting `DB_BACKEND=d1` routes the
  ledger to Cloudflare D1 via `worker/`, so cooldowns/caps persist — verified by
  a fresh process still seeing prior claims.
- **Shielded-first.** Shielded transfers are private; transparent recipients get
  an explicit "this is public" warning.
- **Honest about the soft spots.** Two centralized touchpoints remain, by choice,
  and both are swappable:
  - *Public lightwalletd* — replace with a self-hosted node (above).
  - *Cloudflare Turnstile* — convenient anti-bot, but it's a third party. For a
    fully self-sovereign deploy, swap it for a **proof-of-work / hashcash**
    challenge (no external calls, nothing to track). The Turnstile check lives
    behind one function (`lib/turnstile.ts`), so it's a clean swap.

## Tabs

A tabbed UI (`src/app/page.tsx` + `src/app/tabs/*`), inspired by the Nethermind
Aztec faucet:

- **Faucet** — request TAZ to a shielded or transparent address.
- **Account** — generate a throwaway testnet account. Transparent accounts are
  **real & usable now** (secp256k1 → `tm…` address + testnet WIF); shielded is a
  **mock** (real 24-word seed, placeholder `utest1…` address) until shielded
  (WASM) key derivation is added. Keys are generated server-side, never stored.
- **Balance** — look up a **transparent** address balance live on-chain.
  Shielded balances are private by design and can't be queried from an address.
- **Network** — live block height, sync status, consensus branch, lightwalletd
  version/endpoint; auto-refreshes every 15s.
- **Donate / FAQ** — the faucet's receive address (`FAUCET_DONATION_ADDRESS`) +
  a short FAQ.

## What's in the box

| Piece | File |
| --- | --- |
| Tab shell + shared status | `src/app/page.tsx`, `src/app/tabs/*` |
| Drip endpoint (validate → captcha → rate-limit → balance guard → send) | `src/app/api/faucet/route.ts` |
| Throwaway account generation | `src/app/api/account/route.ts`, `src/lib/zcash/keys.ts` |
| Balance lookup (transparent, live) | `src/app/api/balance/route.ts` |
| Network status | `src/app/api/network/route.ts` |
| lightwalletd gRPC client (failover) | `src/lib/zcash/grpc.ts`, `proto/service.proto` |
| Backend status endpoint | `src/app/api/status/route.ts` |
| Testnet address validation | `src/lib/zcash/address.ts` |
| Send adapter (mock + real) | `src/lib/zcash/send.ts` |
| Real sender: transparent tx build/sign/broadcast | `src/lib/zcash/realsend.ts` |
| Faucet transparent wallet derivation | `src/lib/zcash/wallet.ts` |
| Atomic claim reserve (cooldown + daily cap, concurrency-safe) | `src/lib/db/` |
| Ledger backends: local SQLite + Cloudflare D1 proxy | `src/lib/db/driver.ts` |
| D1 proxy Worker (persistent ledger for ephemeral hosts) | `worker/` |
| Serial FIFO send queue (one wallet tx at a time) | `src/lib/zcash/queue.ts` |
| Turnstile server verify | `src/lib/turnstile.ts` |
| SQLite claim ledger | `src/lib/db.ts` |

## Quick start (mock mode — works immediately)

```bash
npm install
cp .env.example .env
npm run dev      # http://localhost:3000
```

Out of the box `FAUCET_SENDER=mock`: the full flow runs (validation, cooldown,
captcha, DB ledger) but returns a **fake txid** — no real coins move. Perfect for
building and testing the UX before you have a funded wallet.

## Going live (real TAZ)

The real sender ([`realsend.ts`](src/lib/zcash/realsend.ts)) spends a funded
**transparent** testnet wallet — transparent sends need no zk-proof, so they run
on the free tier. Steps (full version in [DEPLOY.md](DEPLOY.md)):

1. **Fund a transparent wallet.** Make a testnet account (the Account tab gives
   you a `tm…` address + WIF) and fund the address from an existing faucet
   (`faucet.zecpages.com`, `fauzec.com`) or the Zcash Discord `#testnet`.

2. **Confirm a live `LIGHTWALLETD_ENDPOINT`** (the default list works today).

3. **Switch to real mode:**
   ```bash
   FAUCET_SENDER=real
   FAUCET_WALLET_SEED=<the WIF>   # or a 64-hex key; server-side only, never commit
   ```
   The first claim to a `tm…` address is the acceptance test: check the returned
   txid on a testnet explorer.

4. **Enable anti-abuse.** Create a [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile)
   widget and set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`.

### Shielded recipients (real mode)

Unified addresses (`utest1…`, Orchard) **are** paid for real, via transparent→
shielded (t2z, [`t2z.ts`](src/lib/zcash/t2z.ts) + [`workers/t2z-worker.mjs`](workers/t2z-worker.mjs)):
the faucet spends its transparent UTXOs, the recipient gets a private Orchard
note, and **change returns to the faucet's own t-address** (verified via
`inspect_pczt`) so nothing strands. The Halo2 proof (~15–26s) runs in a
worker_thread behind the FIFO queue, so it never blocks the server.

- `tm…` (transparent) → real transparent tx (`RealSender`).
- `utest1…` (unified/Orchard) → real t2z shielded send (`T2zSender`).
- `ztestsapling1…` (Sapling-only) → refused; t2z emits Orchard outputs only.

The whole pipeline (propose → sign → prove → finalize) is verified offline; the
final acceptance test is one funded testnet broadcast (see DEPLOY.md).

## Configuration (`.env`)

| Var | Default | Meaning |
| --- | --- | --- |
| `FAUCET_DRIP_TAZ` | `0.1` | TAZ sent per claim |
| `FAUCET_COOLDOWN_SECONDS` | `86400` | Per-address **and** per-IP cooldown |
| `FAUCET_DAILY_CAP_TAZ` | `100` | Global 24h dispense ceiling |
| `LIGHTWALLETD_ENDPOINT` | `testnet.zec.rocks:443` | Light client gRPC endpoint |
| `FAUCET_SENDER` | `mock` | `mock` or `real` |
| `FAUCET_WALLET_SEED` | — | Funded transparent wallet WIF/hex (`real` only) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | — | Anti-bot |

## Supported recipient types

A user pastes **their** address and receives TAZ. All current testnet formats
are accepted and classified ([`address.ts`](src/lib/zcash/address.ts)):

| They send in… | Prefix | Result |
| --- | --- | --- |
| Unified (shielded) | `utest1…` | shielded-to-shielded (private) |
| Sapling (shielded) | `ztestsapling1…` | shielded-to-shielded (private) |
| Transparent | `tm…` / `t2…` | deshielding tx → **public** output |

The API response and UI echo back which type was detected, and transparent
recipients get a "this transfer is not shielded" notice. Mainnet addresses
(`u1…`, `zs…`, `t1…`) are rejected with a clear message.

## Single-wallet model (the "one funded address" approach)

The faucet is backed by **one funded testnet hot wallet** (`FAUCET_WALLET_SEED`).
This is the standard faucet design, hardened here with:

- **Reserve floor** (`FAUCET_MIN_RESERVE_TAZ`) — the faucet reports **empty** and
  refuses drips once the balance would drop below drip + reserve, instead of
  erroring mid-send. The UI disables the button and shows a refill notice.
- **Live balance** — `GET /api/status` returns `balanceTaz` + `empty`; the send
  path re-checks the balance before every drip (`safeBalance()` in `send.ts`).
- **Endpoint failover** — `LIGHTWALLETD_ENDPOINT` takes a comma-separated list;
  endpoints are tried in order and the first reachable one is used.

Recommended operating pattern: keep the hot wallet **intentionally low**, hold a
larger **cold reserve** you control, and top the hot wallet up periodically (or
watch `balanceTaz` and refill when it nears the floor). In mock mode the balance
is simulated via `FAUCET_MOCK_BALANCE_TAZ` so the whole empty/refill flow is
testable without real coins.

## Security notes

- The faucet seed is a hot wallet — keep the balance low and top it up; never
  expose the seed to the browser or commit it.
- Rate-limit + daily cap + reserve floor are the guardrails against draining.
  Tune them and keep Turnstile on in production.
- **Concurrency-safe by construction.** Multiple developers can hit the faucet
  at once. Each claim is reserved in a single synchronous SQLite transaction
  (cooldown + daily cap checked and a `pending` row inserted atomically) *before*
  the send, so N simultaneous requests from the same address/IP can't all pass
  the check and double-drip — load-tested with 5 concurrent requests.
- **Sends run through a serial FIFO queue** (`src/lib/zcash/queue.ts`). The front
  door is concurrent, but the actual send is processed one at a time: the faucet
  is a single hot wallet, so parallel sends would race on the same notes
  (double-spend), and parallel WebZjs proofs would OOM a small instance. A bounded
  backlog (`SEND_QUEUE_MAX_PENDING`) fast-rejects a surge with a "busy" response
  instead of queueing unbounded work. Verified: 5 concurrent sends process
  serially and all succeed; an over-cap burst serves the cap and rejects the rest.
- **Trust your proxy, not the client.** `X-Forwarded-For` is client-writable, so
  per-IP limiting only trusts the last `TRUSTED_PROXY_COUNT` hops (the ones your
  own infra adds). Set it to your real proxy depth (usually `1`); leave it `0`
  and the header is ignored entirely. The spoof-proof backstop regardless of IP
  tricks is `FAUCET_DAILY_CAP_TAZ`.
- SQLite is fine for a single instance. For multi-instance, move the ledger to
  Postgres (swap `src/lib/db.ts`).

## Scripts

```bash
npm run dev        # local dev
npm run build      # production build
npm run typecheck  # tsc --noEmit
```
