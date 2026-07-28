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
  the IP itself.
- **No accounts, emails, cookies, analytics, or trackers.** Nothing to log in to,
  nothing following you.
- **No logging of PII.** Addresses, IPs, and the faucet key are never written to
  logs.

## What it keeps, and for how long

The ledger holds only what's needed to enforce fair use: `address_hash`,
`ip_hash`, amount, status, txid, timestamp. Rows are **purged** once they're
older than the retention window (`max(cooldown, 24h) + 1h`), after which they can
no longer affect a cooldown or the daily cap, so they're deleted.

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
