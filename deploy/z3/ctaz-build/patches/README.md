# cTAZ node source patches

Patches applied on top of the pinned `crosslink_monolith` revision that
`ctaz-build.sh` builds (`CTAZ_SOURCE_REV`, currently `2c346b2`). They exist
because the upstream behaviour is wrong for a faucet box and there is no config
knob to change it, so the fix has to be in the source we build.

## `ctaz-grpc-loopback.patch` — bind the zaino serve gRPC to loopback (#327)

**What it changes.** One line in `zebra-crosslink/zebrad/src/commands/start.rs`:
the embedded zaino's serve gRPC `listen_address` from `0.0.0.0:P+10001` to
`127.0.0.1:P+10001`. The JSON-RPC one line above it is already `127.0.0.1`; the
gRPC was the outlier, hardcoded to all-interfaces with no config override.

**Why it matters.** That gRPC serves `RequestFaucetDonation` — a direct path to
the cTAZ mining wallet that bypasses our PoW gate, cooldown, and daily cap. On
the box it binds `0.0.0.0` (observed as `*:29234`). Today it is unreachable only
because ufw default-denies inbound and now carries an explicit `deny 29234/tcp`.
That makes the firewall load-bearing for wallet safety: a ufw flush would expose
a wallet-drain endpoint. Loopback-binding removes that dependency structurally.

**Interim mitigation already in place.** `ufw deny 29234/tcp` on the box, over
the existing default-deny. This patch is the durable fix that lets us stop
relying on the firewall for this port.

## Applying it

Automatic. The build Dockerfile `COPY`s this directory to `/patches` and
`git apply`s every `*.patch` here on top of the pinned `CTAZ_SOURCE_REV`, right
after checkout and before the compile. It runs `git apply --check` first, so a
patch that no longer applies (upstream moved, or the rev was bumped past it)
fails the build loudly instead of silently shipping an unpatched binary. Adding
a new patch here is all it takes; no Dockerfile change per patch.

The build itself is a heavy containerized Rust compile — do it off the faucet
box (it competes with the running node for CPU/memory), ship the binary, install
by rename (a `cp` onto the running binary gives "Text file busy"), then restart
`ctaz-node`.

## Verifying after deploy

```
ss -lntp | grep 29234        # expect 127.0.0.1:29234, not *:29234
systemctl is-active ctaz-node # expect active
```

Once `29234` is loopback-bound, the explicit ufw deny becomes redundant belt
rather than the only thing standing between the internet and the wallet.
