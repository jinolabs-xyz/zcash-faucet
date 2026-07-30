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

**The faucet's own wallet is shielded too.** It runs a Zallet wallet on its own
node (the Z3 stack), and a drip to a shielded address is a `z_sendmany` out of a
shielded pool with nothing on the public ledger linking the faucet to the person it
paid. Earlier versions of this page called that a future upgrade. It shipped, and
it is what the deployment runs.

Which shielded pool, precisely, because a privacy page should not be vague about
this and an earlier draft of this very paragraph got it wrong. The wallet reports
its holdings under the pool name **`ironwood`**, and Zallet models `ironwood` as a
pool distinct from `orchard`: its own source maps them to separate codes and notes
that Ironwood notes are Orchard-SHAPED but tracked separately. So this page does not
claim the notes are Orchard. It claims what the wallet says, which is a shielded
pool called `ironwood`, Orchard-shaped, and separate from the Orchard pool.

Two limits, since the point of this page is not to flatter us:

- **A transparent recipient is a transparent send.** If you paste a `tm…` address
  the output is public, unavoidably, because that is what a transparent address is.
  The faucet builds that one with revealed-recipient permission explicitly rather
  than by accident, and a shielded address avoids it entirely.
- **Amounts and timing leak at the edges.** The faucet publishes its own balance and
  a drip is a fixed size, so someone watching the balance move can infer that
  *a* drip happened. What they cannot learn is who received it.

## Honest trade-offs (and how to remove them)

- **Cloudflare Turnstile** (optional anti-bot) sends the request to a third party.
  It's off unless keys are set, and **this deployment runs the proof-of-work path
  instead**, so no request reaches Cloudflare. Worth knowing if you run your own:
  the choice follows from whether `TURNSTILE_SECRET_KEY` exists rather than from a
  separate decision, so setting that key alone moves your users' requests to a
  third party. That applies to a box provisioned before `FAUCET_CHALLENGE` was
  added to the deploy template. A box set up from the current template has the mode
  written down explicitly, so the fallback never runs and the key alone changes
  nothing. Proof of work lives behind the same single function
  ([`turnstile.ts`](src/lib/turnstile.ts)), which is what makes either one a clean
  swap.
- **Explorer links** (transparent sends only) point at a third-party explorer,
  and clicking one discloses the txid to them. Shielded sends show no external link.
- **`RATE_LIMIT_SALT`** must be set to a long random secret in production, or the
  address/IP hashes could be brute-forced against a small candidate set.

## Robustness

- Concurrency-safe: atomic single-statement reserve + a serial FIFO queue, so
  simultaneous requests can't double-drip and only one send touches the wallet
  at a time.
- The daily cap is the spoof-proof ceiling on total drain regardless of IP games.
- Proving runs in a worker_thread. If it dies, the next request respawns it.
- The faucet key stays server-side only and is never returned to the browser.
