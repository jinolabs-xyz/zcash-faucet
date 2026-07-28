# Shipping a new build without holding your breath

```bash
/opt/faucet/redeploy.sh
```

That pulls the latest code, builds it, swaps the running container, and waits
for the faucet to answer. If any of that fails, the build that was serving a
minute ago is put back and running again before the command returns.

Install it next to the other ops scripts:

```bash
cp /opt/zcash-faucet/deploy/z3/redeploy.sh /opt/faucet/ && chmod +x /opt/faucet/redeploy.sh
```

## What it actually does

1. Ask the faucet whether it is currently serving drips (`/api/ready`). That
   answer decides how strict the check at the end is.
2. Tag the running image `zcash-faucet:previous`. **Before** anything is
   rebuilt, so there is always a known-good image that has served real
   traffic to fall back to.
3. `git pull --ff-only`, then build.
4. Start the new image and wait for it to answer.
5. On any failure: retag `previous` back to `latest`, restart, wait for it to
   answer.

Volumes are never touched. The rate-limit ledger and the wallet survive every
deploy, and a rollback rolls back code, not data.

## Read the exit code

| Code | Means |
|---|---|
| 0 | the new build is live and healthy |
| 2 | it failed, the old build is serving again, **your change did not ship** |
| 1 | it failed and could not be put back, a human is needed now |

The 2 matters if you script this. `redeploy.sh && echo shipped` must not
print `shipped` after a rollback, so a rollback is deliberately not a
success.

## Why the health gate is two-tier

`/api/health` is liveness: is the process answering. Always required.

`/api/ready` is "can it serve a drip right now", and it is legitimately false
while the node syncs or the wallet refills. So it is required **only if the
faucet was ready before the deploy**. That way:

- a deploy can never quietly turn a serving faucet into a non-serving one,
  because a regression in readiness triggers a rollback;
- and you can still ship during a sync, because the gate does not demand a
  state the faucet was not in to begin with.

A build that comes up live but never becomes ready (bad wallet config,
unreachable backend) is exactly the case the two-tier gate catches, and the
one that a plain "did the container start" check misses.

## Other commands

```bash
redeploy.sh --no-pull    # build and ship what is already checked out
redeploy.sh rollback     # go back by hand, e.g. a bug found an hour later
redeploy.sh status       # what is running, what is available to roll back to
```

`rollback` on its own exits 0 when it works: you asked to go back and it went
back. Only an automatic rollback reports 2, because there the *deploy* is
what failed.

## Tuning

| Variable | Default | Notes |
|---|---|---|
| `REDEPLOY_HEALTH_TIMEOUT` | `120` | seconds to come up before rolling back |
| `REDEPLOY_HEALTH_INTERVAL` | `3` | poll interval |
| `REDEPLOY_REPO_DIR` | `/opt/zcash-faucet` | where the code lives |
| `REDEPLOY_FAUCET_URL` | `http://127.0.0.1:3000` | the app, not Caddy |
| `REDEPLOY_IMAGE` / `REDEPLOY_PREVIOUS_TAG` | `zcash-faucet:latest` / `:previous` | image tags |

Raise the timeout if the box is slow: a first build on a cold cache can take
minutes, and a timeout that fires mid-startup causes a pointless rollback.

## What this does not do

**No zero-downtime swap.** The container restarts, so there is a gap of a few
seconds where Caddy has nothing to proxy to. For a testnet faucet that is
fine, and pretending otherwise would mean running two app containers and
juggling Caddy upstreams for no real gain.

**It does not roll back the node or the wallet.** Only the faucet app image.
Zebra and Zallet are untouched by a deploy, and their recovery paths are
[SNAPSHOTS.md](SNAPSHOTS.md) and [BACKUPS.md](BACKUPS.md).

**It does not roll back a migration.** Nothing here migrates the ledger
schema today. If that ever changes, a rollback will need to consider the
database too, and that is worth a note in this file at the time.
