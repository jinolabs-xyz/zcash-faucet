# Configuration

Every setting is an environment variable, read once at boot in
[src/lib/config.ts](src/lib/config.ts). Amounts are handled internally in
zatoshi so nothing drifts through a float.

Boot fails loudly rather than starting misconfigured in two cases: a reserve low
mark at or above the target, and a placeholder `RATE_LIMIT_SALT` in production
with an anti-abuse gate on.

| Variable | Default | What it controls |
| --- | --- | --- |
| `FAUCET_SENDER` | `zallet` | `zallet` (shielded, production) or `real` (transparent). |
| `FAUCET_DRIP_TAZ` | `0.1` | Amount per claim. |
| `FAUCET_COOLDOWN_SECONDS` | `86400` | Per-address cooldown. |
| `FAUCET_DAILY_CAP_TAZ` | `100` | Ceiling across all claims in 24h. |
| `FAUCET_MIN_RESERVE_TAZ` | `0` | Floor the faucet refuses to spend below. |
| `FAUCET_CHALLENGE` | `turnstile` if its secret is set, else `none` | Anti-abuse gate: `pow`, `turnstile`, `none`. |
| `RATE_LIMIT_SALT` | none | **Required in production** with a gate on. Signs PoW challenges and salts IP hashes. Boot fails on an empty or placeholder value. |
| `FAUCET_POW_BITS` | `20` | Base difficulty in leading zero bits. |
| `FAUCET_POW_ESCALATE_BITS` | `2` | Extra bits per recent claim from the same client. |
| `FAUCET_POW_MAX_BITS` | `26` | Hard difficulty cap. |
| `FAUCET_POW_TTL_SECONDS` | `180` | How long a challenge stays valid. |
| `FAUCET_MINER_ACTIVE` | `false` | Whether the reserve loop may move funds. Off means it arms nothing at all. |
| `FAUCET_RESERVE_TARGET_TAZ` | `15` | Refill stops here. |
| `FAUCET_RESERVE_LOW_TAZ` | `5` | Refill starts below here. Must be under target, checked at boot. |
| `FAUCET_RESERVE_CHECK_SECONDS` | `30` | Reconciler interval. |
| `ZALLET_RPC_URL` | `http://127.0.0.1:28232/` | Zallet JSON-RPC endpoint. |
| `ZALLET_RPC_USER` / `ZALLET_RPC_PASSWORD` | none | Basic auth for that endpoint. |
| `ZALLET_ACCOUNT` | none | Faucet account UUID. The shield sweep and the miner must both target this account. |
| `ZALLET_ADDRESS` | none | Faucet unified address, the spend-from for `z_sendmany`. |
| `ZALLET_MIN_CONF` | `10` | Confirmations before a note is spendable. |
| `TRUSTED_PROXY_COUNT` | `0` | How many proxies **you** run. Only that many rightmost `X-Forwarded-For` hops are trusted. `0` ignores the header, which is the safe default. |
| `LIGHTWALLETD_ENDPOINT` | `https://testnet.zec.rocks:443` | Read-side balance lookups only. Comma-separated list, tried in order. |
| `DB_BACKEND` | `sqlite` | `sqlite` for a normal box, `d1` to keep the claim ledger on Cloudflare D1 when the host disk is ephemeral. |
| `FAUCET_DONATION_ADDRESS` | none | Shown in the UI so people can top the faucet up. |
| `FAUCET_MINING_ADDRESS` | none | Transparent address the miner pays coinbase to. Shown on /donate for anyone pointing hashrate at us. Unset hides that block. |
| `FAUCET_WALLET_SEED` | none | Funded transparent wallet, WIF or 64-hex. Only used by `FAUCET_SENDER=real`. Server side, never commit it. |
| `SEND_QUEUE_MAX_PENDING` | `20` | Sends allowed to queue before the faucet sheds with a busy 503, so a surge cannot pile up unbounded work. |
| `ZALLET_RPC_TIMEOUT_MS` | `15000` | Per-call RPC timeout. Floor of 1000. |
| `ZALLET_OP_TIMEOUT_MS` | `180000` | How long to wait for a shielded build and prove to land. Floor of 5000. Past this the outcome is unknown, not failed. |
| `ZALLET_POLL_MS` | `1500` | Gap between operation-status polls. Floor of 250. |
| `ZALLET_PASSPHRASE` | none | Set only if the wallet is encrypted at rest. Unlocks it per send. |
| `ZALLET_UNLOCK_SECONDS` | `60` | How long that unlock lasts. Floor of 1. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | none | Turnstile widget key. Public by design, it ships to the browser. |
| `TURNSTILE_SECRET_KEY` | none | Turnstile server key. Setting it flips the default gate to `turnstile`. |
| `D1_PROXY_URL` | none | Required with `DB_BACKEND=d1`. The Worker in `worker/` that fronts the D1 ledger. |
| `D1_PROXY_SECRET` | none | Bearer token for that Worker. Required with `DB_BACKEND=d1`. |

Full deploy example: [deploy/z3/faucet.env.example](deploy/z3/faucet.env.example).
