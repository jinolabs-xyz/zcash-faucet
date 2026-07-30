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

| Code | Means | Rolled back? | Page someone? |
|---|---|---|---|
| 0 | the new build is live and healthy | no need | no |
| 2 | **your change did not ship**, and the faucet is serving anyway | yes, or nothing was swapped | no |
| 1 | the faucet **may be down**, and the reason decides what to do next | see below | yes |

Exit 1 has three causes and they need different responses, so read the log rather
than assuming a failed rollback:

| Log says | What happened | The new build is |
|---|---|---|
| `rollback failed` / no previous image | the revert was attempted and did not work | replaced or absent |
| `NOT ROLLING BACK: the readiness probe never answered` | nothing answered, so there was no evidence against the build and it was left alone | **still running** |
| `NOT ROLLING BACK: ... the cause is DATA, not code` | the ledger is unreadable, which a revert cannot fix because volumes are never touched | **still running** |

The last two are the ones worth knowing about, because the instinct on seeing exit
1 is to go looking for a rollback, and in those cases none was attempted. That is
deliberate: a probe that never answered is not evidence against the build, and
reverting code cannot repair data (#229).

The split is about whether to wake anyone. Everything that leaves the faucet
serving is a 2, including the cheap failures where nothing was swapped at all
(a bad `git pull`, a build that does not compile) as well as a successful
rollback. A TypeScript error should not page anyone at 3am for a healthy
faucet.

Exit 1 is deliberately rare: the rollback itself failed, or the health gate
failed on a first deploy with no previous image. Those are the only shapes
where the faucet might not be answering.

And 2 is not success. `redeploy.sh && echo shipped` must not print `shipped`
after a rollback.

## How it reaches the app

By default it does not use the network at all: it runs the probe **inside the
container**, the same way the compose healthcheck does. The app port is
`expose`-only, so nothing on the host can reach `127.0.0.1:3000`, and once
`FAUCET_DOMAIN` is set Caddy answers `:80` with a 308 to HTTPS. Both of those
made a host-side probe fail against a perfectly healthy faucet, which is how
the first real run rolled back a working deploy.

Set `REDEPLOY_FAUCET_URL` only if you publish a port yourself, and point it at
something that answers 200 without a redirect.

If the probe cannot run at all (no URL, and `docker compose exec` fails), the
script says `NOT VERIFIED`, changes nothing, and exits 2. It does not roll
back, because being unable to ask is not evidence of a bad build.

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
