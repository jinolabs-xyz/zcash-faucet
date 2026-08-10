# cTAZ node source patches

Patches applied on top of the pinned `crosslink_monolith` revision that
`ctaz-build.sh` builds (`CTAZ_SOURCE_REV`, currently `2c346b2`). They exist
because the upstream behaviour is wrong for a faucet box and there is no config
knob to change it, so the fix has to live in the source we build.

Both patches are also open upstream as PRs against `ShieldedLabs/crosslink_monolith`
(#56 for the gRPC bind, #55 for the faucet). When those land, drop the matching
patch here and bump `CTAZ_SOURCE_REV`.

## `ctaz-grpc-loopback.patch`: bind the zaino serve gRPC to loopback (#327)

One line in `zebra-crosslink/zebrad/src/commands/start.rs`: the embedded zaino's
serve gRPC `listen_address` goes from `0.0.0.0:P+10001` to `127.0.0.1:P+10001`.
The JSON-RPC one line above it is already `127.0.0.1`; the gRPC was the outlier,
hardcoded to all-interfaces with no config override.

Why it matters: that gRPC serves `RequestFaucetDonation`, a direct path to the
cTAZ mining wallet that bypasses our PoW gate, cooldown, and daily cap. On the
box it bound `0.0.0.0` (observed as `*:29234`), so only ufw kept it off the
internet. That made the firewall load-bearing for wallet safety. Loopback
binding removes the dependency structurally. There is also a belt on the box
(`ufw deny 29234/tcp` over the existing default-deny) in case of a rebuild gap.

## `ctaz-faucet-txid.patch`: faucet blocks until the send lands, returns a txid (#328, #426)

`requestfaucetdonation` used to enqueue the address and return a fixed amount
immediately, before any transaction was built. The reply was success-shaped
whether or not money moved, carried no txid, and a failed build was silently
dropped. So a caller could not tell a paid request from a lost one, which is why
the app recorded cTAZ drips as "sent" while nothing reached the chain.

This reworks the RPC to mirror `wallet_staking_action`, which already does it
right: stage the request with a oneshot channel, block until the tx reaches
`SENT`, and reply with the real txid or a real error. `FaucetResponse` gains a
`txid` field. It also deletes the now-dead `FAUCET_REQUEST` closure, `FAUCET_Q`,
the idle-tick drainer, and the `TEST_FAUCET` fake-read.

Note: a successful cTAZ drip is still gated by a separate upstream problem, the
wallet rescanning from genesis on every restart (~2-day warm-up, no note
persistence), filed as `ShieldedLabs/crosslink_monolith` issue #54. This patch
makes the RPC honest; it does not make the wallet spendable faster.

## Applying it

Automatic. The build Dockerfile `COPY`s this directory to `/patches` and
`git apply`s every `*.patch` here on top of the pinned `CTAZ_SOURCE_REV`, right
after checkout and before the compile. It runs `git apply --check` first, so a
patch that no longer applies (upstream moved, or the rev was bumped past it)
fails the build loudly instead of silently shipping an unpatched binary. Adding
a new patch here is all it takes; no Dockerfile change per patch.

The build itself is a heavy containerized Rust compile, so run it off the faucet
box (it competes with the running node for CPU and memory), ship the binary,
install by rename (a `cp` onto the running binary gives "Text file busy"), then
restart `ctaz-node`.

## Verifying after deploy

```
ss -lntp | grep 29234         # expect 127.0.0.1:29234, not *:29234
systemctl is-active ctaz-node  # expect active
```

For the faucet patch, a call to `requestfaucetdonation` now returns either a
real txid or a real error, never a bare fixed amount. Once the wallet has
finished its rescan and has spendable notes, that txid is a transaction you can
find on the cTAZ chain.
