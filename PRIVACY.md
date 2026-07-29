# Privacy model

This faucet serves the Zcash community, so it's built privacy-first and by data
minimization: it keeps the least it can, hashes what it must keep, and retains
nothing longer than needed.

## What it does NOT store

- **No plaintext recipient addresses.** The ledger stores only a salted hash of
  the address ([`privacy.ts`](src/lib/privacy.ts)). This matters most for
  **shielded** recipients: an Orchard output reveals no recipient on-chain, so
  storing their address in the clear would deanonymize them in a way the
  blockchain itself does not. We refuse to build that record.
- **No raw IPs.** Rate-limiting keys on a salted hash of the client IP, never
  the IP itself. The same is true of the **subnet** described below: the network is
  hashed with the same salt and the same one-way function, so neither the address
  nor the range it came from is recoverable from the ledger.
- **No accounts, emails, cookies, analytics, or trackers.** Nothing to log in to,
  nothing following you.
- **No logging of PII.** Addresses, IPs, and the faucet key are never written to
  logs.

## What it keeps, and for how long

The ledger holds only what's needed to enforce fair use: `address_hash`,
`ip_hash`, `subnet_hash`, amount, status, txid, timestamp. Rows are **purged**
once they're older than the retention window (`max(cooldown, 24h) + 1h`), after
which they can no longer affect a cooldown or the daily cap, so they're deleted.

### About `subnet_hash`, because it is not the same kind of thing as `ip_hash`

A single IP is one claimant. A cloud provider hands one person thousands, which is
why a per-IP cooldown is a speed bump for anyone renting a range. So the ledger
also stores a salted hash of the client's **network** (`/24` for IPv4, `/64` for
IPv6) and caps claims per network per day.

Being straight about what that means, because it cuts both ways:

- It is **less** identifying than `ip_hash`. A `/24` is up to 256 addresses, so the
  hash points at a neighbourhood rather than a door.
- It is a **new kind** of fact about you. From `ip_hash` alone we cannot tell that
  two claims are related. From `subnet_hash` we can tell they came from the same
  network. We could not link two strangers before and now, if they share a range,
  we can see that much.
- It is why a **shared network can be limited by someone else's** claims. An office,
  a university or a NAT looks like one network from outside. The per-network cap is
  set well above what one person needs so this is rare, and it is a real cost we
  chose rather than an accident.
- An IP we cannot parse gets **no** subnet hash and is simply exempt from that rule,
  rather than being put in a shared bucket with every other unparseable address.

It is hashed with the same salt and never stored or logged in the clear, and it is
purged on the same schedule as the rest of the row.

## Shielded-first

Every place a user picks an address, **shielded is the default**. Transparent is
an explicit opt-in toggle. Shielded recipients get a private Orchard note.

## Honest trade-offs (and how to remove them)

- **Cloudflare Turnstile** (optional anti-bot) sends the request to a third party.
  It's off unless keys are set. For a fully self-sovereign deploy, swap it for a
  **proof-of-work / hashcash** challenge: it lives behind one function
  ([`turnstile.ts`](src/lib/turnstile.ts)), so it's a clean replacement.
- **Explorer links** (transparent sends only) point at a third-party explorer,
  and clicking one discloses the txid to them. Shielded sends show no external link.
- **The faucet's own wallet is transparent**, so the faucet's spending is public
  (a faucet isn't hiding). Recipient privacy, the thing that matters, is
  preserved: shielded recipients receive private notes. A fully-shielded faucet
  wallet (Zallet/Z3 or zingolib) is the future upgrade if faucet-side privacy is
  wanted too.
- **`RATE_LIMIT_SALT`** must be set to a long random secret in production, or the
  address/IP hashes could be brute-forced against a small candidate set.

## Robustness

- Concurrency-safe: atomic single-statement reserve + a serial FIFO queue, so
  simultaneous requests can't double-drip and only one send touches the wallet
  at a time.
- The daily cap is the spoof-proof ceiling on total drain regardless of IP games.
- Proving runs in a worker_thread. If it dies, the next request respawns it.
- The faucet key stays server-side only and is never returned to the browser.
