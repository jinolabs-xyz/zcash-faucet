# Operations

The 3am runbook for the faucet box. Every section is short on purpose and
points into the deep doc that owns the topic. The box is a single Ubuntu VM
running docker compose stacks plus a handful of systemd units, with the repo
checked out at `/opt/zcash-faucet`.

## What runs where

| Thing | Runs as | Where | Deep doc |
|---|---|---|---|
| zebra (full node) | docker, z3 project `z3-testnet` | `/opt/zcash-faucet/deploy/z3-stack` | [deploy/z3/README.md](deploy/z3/README.md) |
| zallet (shielded wallet) | docker, same z3 project | `/opt/zcash-faucet/deploy/z3-stack` | [deploy/z3/README.md](deploy/z3/README.md) |
| faucet web app (Next.js) | docker, project `zcash-faucet` | `/opt/zcash-faucet/deploy/z3/docker-compose.faucet.yml` | [deploy/z3/README.md](deploy/z3/README.md) |
| caddy (HTTPS, ports 80/443) | docker, same overlay | same compose file | [deploy/z3/HTTPS.md](deploy/z3/HTTPS.md) |
| boot bring-up | systemd `faucet.service` (oneshot, cloud-init boxes) | runs `/usr/local/bin/faucet-up` | [deploy/cloud-init.yaml](deploy/cloud-init.yaml) |
| watchdog (self-healing) | systemd `faucet-watchdog` | `/opt/faucet/watchdog.sh` | [deploy/z3/watchdog.sh](deploy/z3/watchdog.sh) header |
| solo CPU miner | systemd `zcash-testnet-miner` | `/opt/faucet/zcash-testnet-miner` | [deploy/z3/MINING.md](deploy/z3/MINING.md) |
| chain snapshot export | systemd `zsnap-export.timer` | `/opt/faucet/zsnap-export.sh` | [deploy/z3/SNAPSHOTS.md](deploy/z3/SNAPSHOTS.md) |
| encrypted backups | systemd `faucet-backup.timer` | `/opt/faucet/backup.sh` | [deploy/z3/BACKUPS.md](deploy/z3/BACKUPS.md) |
| metrics textfile | systemd `faucet-metrics.timer` | `/opt/faucet/faucet-metrics.sh` | [deploy/z3/OBSERVABILITY.md](deploy/z3/OBSERVABILITY.md) |
| alerting | `faucet-alert@.service`, wired as `OnFailure=` on every unit above | `/opt/faucet/alert.sh` | [deploy/z3/OBSERVABILITY.md](deploy/z3/OBSERVABILITY.md) |
| drift and access audit | systemd `faucet-drift-report.timer` (daily 03:40) | `/opt/faucet/drift-report.sh` | [drift section](#config-drift) |

Only caddy is public. Zebra and zallet RPC stay on the private docker
network. Everything docker is `restart: unless-stopped`, so a reboot brings
the containers back without help.

Any unit above failing posts to the alert webhook with its last journal lines,
so a timer cannot fail silently. That is what `OnFailure` buys.

### Tools you run by hand

Nothing schedules these. All are read-only except `redeploy.sh` and
`restore-backup.sh`.

| Tool | Answers | Deep doc |
|---|---|---|
| `redeploy.sh` | ship a build, health-gated, auto-rollback | [REDEPLOY.md](deploy/z3/REDEPLOY.md) |
| `redeploy.sh rollback` / `status` | go back; what is running | [REDEPLOY.md](deploy/z3/REDEPLOY.md) |
| `audit-drift.sh` | what is on the box that the repo does not describe | [drift section](#config-drift) |
| `audit-access.sh` | what is exposed, and how sshd throttles | [box access](#box-access-what-is-exposed-and-the-ssh-resets) |
| `zsnap-export.sh preflight` | can the export binary read this chain state | [SNAPSHOTS.md](deploy/z3/SNAPSHOTS.md) |
| `zsnap-publish.sh` | put a snapshot where a replacement box can fetch it | [SNAPSHOTS.md](deploy/z3/SNAPSHOTS.md) |
| `restore-backup.sh` | put the wallet and ledger back | [BACKUPS.md](deploy/z3/BACKUPS.md) |
| `alert.sh --self-test` | does paging actually work | [OBSERVABILITY.md](deploy/z3/OBSERVABILITY.md) |

## Start, stop, status

z3 stack (node + wallet), from `/opt/zcash-faucet/deploy/z3-stack`:

```bash
docker compose --env-file .env.testnet up -d      # start
docker compose --env-file .env.testnet down       # stop (never `down -v`)
docker compose --env-file .env.testnet ps         # status
```

Faucet overlay (web app + caddy), from `/opt/zcash-faucet/deploy/z3`:

```bash
FAUCET_DOMAIN=$(cat /etc/faucet-domain) \
  docker compose -f docker-compose.faucet.yml up -d --build   # start / rebuild
docker compose -f docker-compose.faucet.yml down              # stop
docker compose -f docker-compose.faucet.yml ps                # status
```

systemd units, same three verbs everywhere:

```bash
systemctl status|start|stop|restart faucet-watchdog
systemctl status|start|stop|restart zcash-testnet-miner
systemctl list-timers 'faucet-*' 'zsnap-*'      # when the timers fire next
systemctl start faucet-backup                   # run a backup right now
systemctl start zsnap-export                    # run a snapshot right now
```

The watchdog restarts fallen containers within 30 seconds, so if you stop a
container on purpose for a maintenance window, stop the watchdog first and
start it again after.

## Logs

```bash
journalctl -u faucet-watchdog -f          # what the watchdog did and why
journalctl -u zcash-testnet-miner -f      # templates, solves, proposals
journalctl -u zsnap-export -f             # snapshot exports
journalctl -u faucet-backup -f            # backup runs
journalctl -u faucet-metrics --since -1h  # metrics collector
```

Container logs go through docker:

```bash
docker logs --tail 200 -f <container>     # find names with `docker ps`
docker compose -f docker-compose.faucet.yml logs caddy   # from deploy/z3
```

First-boot bring-up on a cloud-init box logs to `/var/log/faucet-deploy.log`.

## Health vs ready

Two endpoints, two different questions. Source of truth is
[src/app/api/health/route.ts](src/app/api/health/route.ts) and
[src/app/api/ready/route.ts](src/app/api/ready/route.ts).

- `GET /api/health` is liveness: is the web process answering at all. It
  does no backend work and is always cheap. The watchdog restarts the web
  container after 3 consecutive misses.
- `GET /api/ready` is readiness: can the faucet serve a drip right now.
  200 when yes, 503 with a JSON `reason` when no. The reason is the most
  upstream blocker, checked in this order:

| Reason | Means |
|---|---|
| `backend unreachable` | the lightwalletd/Zaino read endpoint is not answering |
| `node syncing` | zebra is not at tip yet, normal on first sync or after a restore |
| `wallet balance unknown` | zallet did not return a balance, usually zallet itself is down |
| `below reserve, refilling` | funds are under drip + reserve, faucet needs a refill |

Un-ready is not an outage by itself. First sync and refills are un-ready on
purpose, which is why the watchdog only pages after a 30 minute grace window.

## Redeploy

`deploy/deploy.sh` is re-runnable and skips what is already done, so a
redeploy is a pull plus a re-run:

```bash
cd /opt/zcash-faucet
git pull
NETWORK=testnet FAUCET_DOMAIN=$(cat /etc/faucet-domain) ./deploy/deploy.sh

### Where mining rewards go

`FAUCET_MINER_ADDRESS` is what funds this faucet. `deploy.sh` writes it into
`deploy/z3-stack/docker-compose.override.yml` and passes `COMPOSE_FILE` through
the shell, so z3's own tracked files stay pristine and the clone can be thrown
away and re-cloned.

It used to live only as a hand-written override inside that gitignored clone,
plus a hand edit to z3's `.env.testnet` to load it. Both are invisible to
`git status` and to `audit-drift.sh`, which reads units and `/opt/faucet`, not a
vendor clone. A rebuild therefore produced a box that came up with **no miner
address**, mining nothing, with nothing in the repo explaining why.

If the file exists and the variable is unset, `deploy.sh` keeps the file rather
than unfunding a running box, and says out loud that the box is not reproducible.

```

For a web-app-only change, rebuilding the overlay is enough (the compose
`up -d --build` from the start/stop section). Wallet, chain state, ledger and
TLS material all live in named volumes and survive rebuilds.

## Recovering mined coinbase into spendable balance

Written for the specific state this box is in after the July 2026 incident, and
reusable for any future "coinbase is mined but not spendable" situation. Run it
**only after the wallet is healthy**. The wallet repair is a different runbook
and this one assumes it succeeded.

The situation it exists for: 47.5 TAZ of mined coinbase sitting at the
transparent miner address while the faucet served a shortage, because the reserve
loop was not permitted to sweep it and said nothing about that (#172).

**Read this warning before step 5.** The shield transaction that broke this
wallet was created by the same operation this runbook performs. A previous
`z_shieldcoinbase` was built, broadcast, never confirmed, expired, and left a
retrieval-queue entry that crashed zallet 221 times. **A sweep that broadcasts
and does not confirm recreates the incident.** Step 5 therefore watches for
confirmation, not for broadcast.

Every command below is a read unless it says otherwise. Two writes exist in the
whole sequence: step 3's deploy and step 4's env edit.

### 1. Put the verifier in place first

Infra owns the mechanics ([their delivery install](#monitoring-and-alerts)); this
sequences it first because it is what will tell you if the rest goes wrong.

Installing the script alone is not enough. The watchdog ran for months with
`alert=none`, `alert.sh` absent and `/etc/faucet/watchdog.env` missing, so 812
"recovered" messages went to the journal and nowhere else.

**The read that proves it:**

```sh
journalctl -u faucet-watchdog -n 20 | grep 'watchdog: starting'
```

**Proof is `alert=` naming a real target.** `alert=none` means the verifier is
installed and still cannot tell anyone anything, which is the state that hid this
incident. Do not proceed on `alert=none`.

**Failure mode:** the line says `alert=none` after the install. The env file or
`alert.sh` did not land. Fix that before continuing, because a recovery you cannot be
told about failing is not a recovery you should attempt.

### 2. Confirm the wallet is actually stable

Two independent reads, because "it started" and "it stays up" are different
claims and this wallet has satisfied the first 221 times.

```sh
# a. restart count, twice, at least 5 minutes apart. It must not move.
docker inspect -f '{{.RestartCount}}' z3-testnet-zallet-1

# b. the app's own view
curl -s localhost:3000/api/status | jq .reserve
```

**The read that proves it:** the restart count is **identical** across two reads
five minutes apart, and `.reserve.blindTicks` is `0`. A zero there means the app
successfully read a balance from the wallet on its last tick, which is positive
evidence that the wallet answers.

**How to read `.reserve` honestly**, because two of its fields are easy to
misread:

| reading | what it means |
|---|---|
| `blindTicks: 0` | the balance was readable. Positive evidence the wallet answers. |
| `blindTicks > 0` | the loop is **blind**, not idle. The wallet is not answering. |
| `refilling: true` | the loop has ticked, so the background layer is alive. |
| `refilling: false` | **proves nothing either way.** With an unreadable balance the loop correctly holds this at false. Do not read it as a fault. |
| no `.reserve` object at all | the only reading that indicates a real instrumentation failure. |

**Failure mode:** the restart count moves between the two reads. The wallet is
still looping. **Stop.** Go back to the wallet repair. Nothing below is safe
while the wallet cannot stay up, and a sweep attempted against a restarting
wallet is how the expired transaction happened.

### 3. Merge #174 so the flag exists on the box

`FAUCET_SHIELD_COINBASE` must be **present** before anyone can set it, and it
will not appear on its own. `write_env` copies `faucet.env.example` only on a
fresh box, so a key added to the example never reaches an existing deployment.
#174 makes `deploy.sh` append it when absent.

```sh
cd /opt/zcash-faucet && git pull
NETWORK=testnet FAUCET_DOMAIN=$(cat /etc/faucet-domain) ./deploy/deploy.sh   # WRITE
grep '^FAUCET_SHIELD_COINBASE' deploy/z3/faucet.env
```

**The read that proves it:** `FAUCET_SHIELD_COINBASE=false`. Present, and still
false. It is deliberately not `true` yet: that is step 4 and it is not yours.

**Failure mode:** `grep` finds nothing. The deploy did not run `write_env`, or ran
an older `deploy.sh`. Check `git log -1` in the checkout matches the merged #174.
Adding the line by hand also works and is safe, since the append never overwrites.

### 3.5 Establish why the first shield died, before permitting a second

**Precondition, not a post-hoc watch.** The previous `z_shieldcoinbase` was built,
broadcast, never confirmed, and expired unmined at height 4,217,981 with a fee of
15,000 zatoshi. If whatever killed it is still true, a new shield dies the same
way the moment step 4 flips the flag, and we will have done all of this to
recreate the poison we just removed.

What is already ruled out, so nobody spends time there:

**Block production is not the cause.** VERIFIED: the network tip is past that
expiry by more than two thousand blocks. A transaction expires because the chain
*advanced* without including it, so miners were active throughout and ours was in
none of their blocks. "Testnet was quiet" is not the explanation.

**The fee is not the suspect.** VERIFIED from the code: the refiller passes
`null` as the fee, so zallet computes it under ZIP 317 rather than us choosing a
number. 15,000 zatoshi is three times ZIP 317's 5,000 marginal fee, which is a
conformant fee for a small shield. A hand-picked too-low fee would be a good
theory and it is not what happened.

That leaves two candidates, and one of them we can already test with a field we
built for something else.

**Candidate A: our node was behind the network when it built the transaction.**
A wallet sets `expiry_height` from *its own node's* tip. A node that has drifted
behind builds a transaction whose expiry is already in the network's past, so it
can never be mined regardless of fee or relay. It looks perfectly valid locally
and is dead on arrival everywhere else.

I proposed this as one mechanism explaining two mysteries, the non-confirmation
and the multiplicity, and **the multiplicity half was refuted by the box.** The
wallet holds nine unmined transactions and eight are bare placeholder rows with no
body, no fee, no expiry and no notes. They were never built by us and carry
nothing. There was exactly **one** self-shield, and it is the one already removed.

So repeated failing shields is not what happened, and the grounds for the refusal
below are narrower than I first claimed: not "our shields systematically fail",
but **"we cannot explain the one failure we saw"**. That is weaker and still
sufficient to wait.

**Separate the two questions, because only one of them can block recovery.**

| question | tense | what it decides |
|---|---|---|
| was the node behind when it built the dead transactions | past | *why this happened*. Diagnosis. Does not block anything. |
| is the node at the true tip **right now** | present | *whether it is safe to shield again*. This is the gate. |

A node that drifted historically and has since caught up is **safe to shield
from** once the poison is removed. So a confirmed diagnosis of past drift is not a
reason to refuse the recovery, and nobody should read it that way. The only
reading that blocks step 4 is a present-tense disagreement between our tip and
the network's.

**Two dependencies before this read works at all**, both found by SDE-Infra
trying to run it rather than by me writing it.

1. `externalHeight` and `frozen` **do not exist on the deployed build.** They
   arrive with #171, which is not merged. On today's box `.node` carries no such
   fields, so the read below is not available yet.
2. Even once #171 lands, `nodeHeight` comes from **zallet's** `getwalletstatus`,
   not from zebra directly. A dead wallet makes `getNodeStatus()` return null and
   takes every height with it. So this gate cannot be satisfied while the wallet
   is down, which makes it strictly dependent on step 2 having passed.

Once #171 is merged and deployed and the wallet is up:

```sh
curl -s localhost:3000/api/status | jq '.node | {nodeHeight, externalHeight, frozen}'
```

**The fallback that works today, and is better for this purpose anyway.** Ask
zebra its height directly and compare against a source that is not us. This has
no zallet dependency, so it works while the wallet is still broken:

```sh
# our node, straight from zebra
docker exec z3-testnet-zebra-1 \
  curl -s --data '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
  -H 'content-type: application/json' http://127.0.0.1:18232/ | jq .result

# the network, per an aggregate we do not run
curl -s https://hosh.zec.rocks/api/v0/zec.json \
  | jq '[.servers[] | select(.chain=="test" and .online) | .height] | max'
```

**Proof required before step 4:** the two numbers agree within a few blocks.

Do not accept `frozen: false` as the gate on its own. It only trips past
`FAUCET_FREEZE_BLOCKS` (200), so a node 150 blocks behind reads as healthy while
still stamping transactions with an expiry that has already passed. Compare the
numbers yourself. A null or missing external tip is cannot-verify, which is not a
pass.

**Candidate B: the transaction never reached the network.** Peer count, relay, and
whether our mempool is reachable at all. This needs box reads and it is
SDE-Infra's verification-layer territory rather than mine. INFERRED, not
verified: if candidate A comes back clean, B is what remains, and a shield that
our own node accepted and no miner ever saw is a relay problem.

**If neither can be established, do not flip the flag.** An unexplained failure
of exactly this operation is a reason to wait, not a reason to retry. The coinbase
is not going anywhere, and the cost of guessing wrong is a second poisoned wallet
plus another day of outage.


### 4. The operator authorises the sweep

**This step is the user's decision, not an automatic part of the sequence.**

Setting this flag permits the faucet to broadcast a transaction that moves real
funds. It is a money-path authorisation and the runbook deliberately stops here
until a human makes it. Nobody should flip it because the previous five steps
went well.

```sh
# WRITE, and only on the user's explicit say-so
sed -i 's/^FAUCET_SHIELD_COINBASE=false/FAUCET_SHIELD_COINBASE=true/' \
  /opt/zcash-faucet/deploy/z3/faucet.env
cd /opt/zcash-faucet/deploy/z3 && docker compose restart faucet
```

**The read that proves it:**

```sh
curl -s localhost:3000/api/status | jq '.reserve.shieldCoinbase, .reserve.refilling'
```

Expect `true` and `true`: permitted to sweep, and wanting to. If
`shieldCoinbase` is still false the restart did not pick up the env.

**Rollback, and its honest limit:** set the flag back to `false` and restart. That
stops any *further* sweep. It does **not** unwind a transaction already
broadcast, and nothing can. That is why the authorisation is a human decision and
why step 5 exists.

### 5. Watch the sweep move funds, and confirm

This is the step that recreates the incident if it goes wrong, so watch for
**confirmation** rather than for the attempt.

```sh
docker compose logs -f --since 5m faucet | grep '\[reserve\]'
```

Read the verdict, not the vibe. #174 makes each outcome distinct on purpose:

| log line | meaning | action |
|---|---|---|
| `verdict=moved` | funds moved and the operation landed | proceed to step 6 |
| `verdict=present-but-unspendable`, `remainingUTXOs` non-zero | coinbase **exists** and this account cannot spend it | **stop.** The miner address is not a receiver of `ZALLET_ACCOUNT`. Waiting will not fix it. This needs the address rewired or the key imported, which is its own decision. |
| `verdict=nothing-visible`, `remainingUTXOs: 0` | the backend reports genuinely nothing mature | normal shortly after a block. Coinbase needs 100 confirmations. Wait, do not act. |
| `verdict=count-not-reported` repeating | zallet does not report `remainingUTXOs` at all | we are **blind** on this signal. Not a failure of the sweep, a failure to observe it. Fall back to reading `spendableTaz` in step 6 and treat the sweep as unverified. |

**The read that proves the confirmation, which is the one that matters:**

```sh
# a shield that broadcast but never confirmed is the exact failure that
# expired and crashed this wallet. Height must ADVANCE past the tx.
curl -s localhost:3000/api/status | jq '.node.nodeHeight, .reserve.spendableTaz'
```

`spendableTaz` **rising** is the only positive proof the shield confirmed. A
broadcast with a flat `spendableTaz` over several blocks is the incident
happening again.

**Failure mode:** `emptySweeps` climbing while `refilling` stays true. The loop
wants to refill and every attempt finds nothing. Read the verdict column above
before waiting any longer: three of the four rows mean "waiting will not help".

### 6. Confirm the money is spendable and serve a real drip

```sh
curl -s localhost:3000/api/status | jq '.reserve'
curl -s localhost:3000/api/ready | jq '.ready, .reason'
```

**The reads that prove it:**

- `spendableTaz` at or near the recovered amount
- `refilling: false`, the hysteresis stopped on its own because the target was
  reached, which is different from never having started
- `/api/ready` returns `ready: true` with a null reason

Then the acceptance test that is not a status read: **claim a real drip** and
confirm the txid on an independent explorer, not only in our own response. Our
node agreeing with itself is what #170 and #171 are about.

**Failure mode:** `spendableTaz` rose but `/api/ready` still refuses. Read
`.reason`. `below reserve, refilling` means the sweep recovered less than
`drip + minReserve`, so the sweep worked and was not enough. `node frozen behind
network` is unrelated to this runbook and is #171's signal.

### What this runbook does not cover

- The wallet repair itself. Separate, and it comes first.
- Rewiring the miner address if step 5 says `present-but-unspendable`. That is a
  key-custody decision, not an operations step.
- Turning mining back on. `FAUCET_MINER_ACTIVE` is a different flag for a
  different question and nothing here needs it.

## Rollback

`redeploy.sh` keeps the previously running image tagged `zcash-faucet:previous`
and can put it back in one command:

```bash
/opt/faucet/redeploy.sh rollback
```

That is also what a failed deploy does on its own, so most of the time the
rollback has already happened by the time you are reading logs. Check what is
running and what is available to go back to:

```bash
/opt/faucet/redeploy.sh status
```

See [REDEPLOY.md](deploy/z3/REDEPLOY.md) for the exit codes. The short version
while you are half awake: **2 means the faucet is serving and the change did
not ship, so it can wait until morning. 1 means the faucet may be down.**

If that image is gone, which happens on a freshly rebuilt box or if the tag
was pruned, build from the last good commit instead:

```bash
cd /opt/zcash-faucet
git log --oneline -10                 # pick the last good sha
git checkout <sha>
cd deploy/z3
FAUCET_DOMAIN=$(cat /etc/faucet-domain) \
  docker compose -f docker-compose.faucet.yml up -d --build
```

Return to main with `git checkout main` and redeploy when fixed. Rolling back
code never touches the volumes, so funds and the rate-limit ledger are safe,
either way.

## Box access: what is exposed, and the ssh resets

```bash
/opt/faucet/audit-access.sh            # what is reachable, and how sshd throttles
/opt/faucet/audit-access.sh --verbose  # also list what matched
```

Read-only, applies nothing. Exit `0` clean, `1` findings, `2` the audit was
incomplete (so it never reports clean on checks it could not run).

### The intended exposure

Public: **22, 80, 443**, plus **18233** (Zebra P2P, where inbound peers are the
point). Nothing else. The app's own port is `expose`-only, and the node and
wallet RPC are bound to loopback on the host.

**ufw cannot close a docker-published port.** Docker writes its own iptables
chain, which is consulted before ufw's rules, so `ufw deny 18232` does nothing
to a container publishing 18232. The host **binding** is the only control, which
is why `deploy.sh` passes loopback host bindings when it brings up the z3 stack:

| Port | Was | Now | Why |
|---|---|---|---|
| 18232 | `0.0.0.0` | `127.0.0.1` | Zebra RPC, can read the chain and submit blocks |
| 18080 | `0.0.0.0` | `127.0.0.1` | Zebra health, still reachable by our own probes |
| 40232 | `0.0.0.0` | `127.0.0.1` | **Zallet RPC, this one can move funds** |
| 18137, 18237 | not published | `127.0.0.1` | Zaino, only under the indexer profile |
| 18233 | `0.0.0.0` | unchanged | P2P needs inbound peers |

Those are shell values, which take precedence over `--env-file`, so nothing in
z3's own files is edited and the change survives a `git pull` of z3.

Loopback binding does not affect the faucet: it reaches zallet over the shared
docker network, not the host. Our own host-side probes (`zsnap-export.sh`'s
ready gate on `127.0.0.1:18080`) keep working for the same reason.

Verify after a bring-up:

```bash
ss -Hltn | awk '{print $4}' | sort -u       # 18232/18080/40232 should show 127.0.0.1
/opt/faucet/audit-access.sh
```

Applying firewall changes, **with a second session already open** so a mistake
is recoverable:

```bash
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable
ufw status                              # confirm before closing that session
```

### Why ssh connections keep resetting

`kex_exchange_identification: Connection closed by remote host` under
connection churn is sshd or the firewall dropping *unauthenticated*
connections. It is not a network fault. Work through these in order, cheapest
and least invasive first.

**1. Fix it on your own machine, not the box.** Parallel ops calls each open a
new TCP connection, and connection multiplexing makes them share one:

```
# ~/.ssh/config
Host 172.235.26.235 faucet.*
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
```

Neither the ufw limit nor `MaxStartups` is approached, because there is one
connection instead of ten. **This changes nothing on the box, needs no
sign-off, and is reversible by deleting three lines.** Try it before anything
below. (Finding credited to SDE-App, who proposed it over the server-side
change.)

Proven on this box: six parallel connections, zero resets, nothing altered
server-side.

One gotcha from that run. The **first** parallel burst can still fail, because
several clients race to become the master before the control socket exists. Warm
it once, then fan out:

```bash
ssh -o ControlMaster=yes -o ControlPersist=10m -fN root@<box>   # open the master
ssh -O check root@<box>                                        # confirm it is up
# now run the parallel work
```

A wrapper that opens the master before any loop is worth more than retry logic
in every script.

**2. `ufw limit` on ssh, if the audit reports LIMIT.** That is a hardcoded 6
connections per 30 seconds per source, with no gentler setting to tune, so the
only ufw answer is `allow`. Be explicit about what that costs:

```bash
ufw allow OpenSSH      # fixes the drops AND removes brute-force rate limiting
```

Only do that with the compensating controls in place, all three:
keys-only authentication (`PasswordAuthentication no`), `fail2ban` installed and
banning on ssh, and the audit confirming nothing else is publicly bound. A
public ssh port with neither rate limiting nor fail2ban is worse than the
resets.

**3. `MaxStartups`, only if 1 and 2 did not settle it.** The default
`10:30:100` starts random early drop at 10 concurrent unauthenticated
connections. `30:30:100` raises the start of the curve and leaves the ceiling,
so it cannot lock anyone out by being too strict.

**Find out where it actually comes from first.** On Ubuntu 24.04 the first
directive in `sshd_config` is `Include /etc/ssh/sshd_config.d/*.conf`, and sshd
takes the **first** value it obtains, so a drop-in beats the main file:

```bash
sshd -T | grep -i maxstartups        # what sshd will really enforce
grep -rn MaxStartups /etc/ssh/sshd_config /etc/ssh/sshd_config.d/   # where it is set
```

Editing the main file when a drop-in sets it does nothing: `sshd -t` passes,
the reload succeeds, and the resets continue. That is the dangerous path,
because it looks like the small safe change was tried and failed, and invites a
bigger change on the only door.

Then:

```bash
sshd -t                    # validate BEFORE reloading
systemctl reload ssh       # reload, never restart: reload keeps live sessions
```

**Keep a second session open and confirm a fresh connection works before
closing it.** This box has one door.

**Socket activation caveat, unverified.** Ubuntu 24.04 enables `ssh.socket` by
default, and under socket activation systemd owns the listening socket, which
is why `Port` and `ListenAddress` changes there are famously ignored.
`MaxStartups` should still apply because sshd accepts connections itself, but
we have not confirmed that a `reload` picks the change up on this box. The
audit reports whether `ssh.socket` is enabled. **Confirm on the box and record
the answer here**, rather than trusting this paragraph.

If resets continue after all three, the remaining suspects are `fail2ban`
banning the operator IP and per-source rate limiting upstream of the box.
Neither is visible to this audit.

## Config drift

The repo is supposed to describe the box. In practice a box accumulates hand
work (a drop-in, an override, a unit copied straight into
`/etc/systemd/system`) and a rebuild silently loses it. Nothing breaks
loudly: the new box comes up, serves, and is quietly missing something only
the person who typed it knows about.

```bash
/opt/faucet/audit-drift.sh            # what is here that the repo does not describe
/opt/faucet/audit-drift.sh --verbose  # also show matches and drop-in contents
```

Exit codes: `0` no drift, `1` drift found, `2` the audit was incomplete. That
last one covers both "could not run at all" and "ran but skipped a check", for
example enablement when there is no `systemctl`. Anything it could not check
is listed under `NOT VERIFIED`, and it never claims the box matches the repo
on the strength of checks it did not perform.

Every finding prints the command that fixes it, so acting on a report is a
paste rather than a puzzle.

### It runs itself, daily

`faucet-drift-report.timer` runs both audits at 03:40 and alerts with the cause
named, so nobody has to remember to check:

```bash
cp audit-drift.sh audit-access.sh drift-report.sh /opt/faucet/ && chmod +x /opt/faucet/*.sh
cp faucet-drift-report.service faucet-drift-report.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now faucet-drift-report.timer
journalctl -u faucet-drift-report -n 200      # the last report, findings and fixes
```

Four outcomes, and the alert says which:

| Outcome | Alert | Unit result |
|---|---|---|
| clean | none | success |
| drift found | "drift found ... a rebuild would not reproduce it" | success, it reported |
| incomplete | "INCOMPLETE ... drift may exist unseen" | success, it reported |
| an audit could not be run at all | `OnFailure` pages | failure |
| a finding could not be delivered | `OnFailure` pages, cause named in the journal | failure |

Findings alert themselves rather than riding on a unit failure, because "unit
failed" does not tell you whether the box drifted or whether the check could not
see. What is left to `OnFailure` is the wrapper's own problems rather than facts
about the box: an audit it could not run, and a finding it could not deliver.

That last row is the one worth understanding. Audit-blind means we do not know.
Alert-failed means we **do** know and the person who needs to does not, so the
unit goes red on purpose: with the webhook broken, `systemctl` is the only
signal left, and a green timer there would hide the drift. The journal names
which of the three delivery failures it was, because they want different fixes:

```
journalctl -u faucet-drift-report -n 200 | grep 'ALERT NOT SENT'
  no FAUCET_ALERT_URL configured    -> set one in /etc/faucet/alerts.env
  no jq and no python3              -> install either one
  alert.sh exited 1                 -> the webhook rejected the POST, check the URL
```

A box with no webhook configured stays green while it is clean. It only goes
red once drift exists **and** there is no way to tell anyone.

`Persistent=true`, so a box that was off at 03:40 gets audited on its next boot
rather than skipping a day.

It is **read-only and has no `--apply`**. Reconciling the box to the repo
would delete the very hand work the audit exists to surface. The fix for
drift is putting the change into the repo: a hand-installed unit or drop-in
belongs in `deploy/z3/` and in the install docs, an untracked override
belongs in git, and a stale script in `/opt/faucet` means re-copying it or
admitting the box is ahead of review.

Env files are reported as present or absent only. Drop-ins print on an
allowlist: `KEY=<redacted>` lines and nothing else, so a continuation line
carrying `--rpc-password` or a comment carrying a webhook cannot leak. You
learn which key was set by hand, not its value.

## Restore from backup

The backup covers the two things the box cannot regrow: the wallet (keys and
funds) and the rate-limit ledger. Full detail and the gates the restore
enforces are in [deploy/z3/BACKUPS.md](deploy/z3/BACKUPS.md).

```bash
# stop everything holding the databases open
cd /opt/zcash-faucet/deploy/z3 && docker compose -f docker-compose.faucet.yml down
cd /opt/zcash-faucet/deploy/z3-stack && docker compose --env-file .env.testnet down

/opt/faucet/restore-backup.sh                             # newest local archive
/opt/faucet/restore-backup.sh /path/to/archive.tar.gz.gpg # or a specific one

cd /opt/zcash-faucet && ./deploy/deploy.sh                # bring it all back
```

You need `BACKUP_PASSPHRASE` from `/etc/faucet/backup.env` or the team
password store. Without it the archives are noise. Zallet re-scans from the
wallet birthday on first start, so expect a short catch-up before balances
look right.

## Restore from snapshot

Snapshots make chain recovery minutes instead of a day. The whole story,
including hot vs cold exports and the preflight check, is in
[deploy/z3/SNAPSHOTS.md](deploy/z3/SNAPSHOTS.md).

- Fresh box: fill `/etc/zsnap-restore-url` and `/etc/faucet/zsnap.env` in
  `deploy/cloud-init.yaml` before pasting it into the provider. The boot path
  imports the snapshot before zebra starts, automatically.
- Existing box, chain state gone or wiped on purpose:

```bash
/opt/faucet/zsnap-import.sh /var/lib/zsnap/snapshots/latest.tar.zst
```

The import verifies every chunk against the manifest and is atomic, a crash
mid-import cannot leave state zebra would open. It refuses to run over
existing state. Snapshots live in `/var/lib/zsnap/snapshots/` and rotate to
the newest `ZSNAP_KEEP`.

## Miner

The miner works public testnet blocks, and one has survived: block 4208641,
whose coinbase the reserve loop shielded on its own. A dominant miner takes
most races though, so mining is upside rather than a supply you can plan
around, and the wallet is topped up from elsewhere. Do not treat a quiet miner
as an outage, and do not expect an empty faucet to refill itself in any useful
time. The measurement and
the reasoning are in [deploy/z3/MINING.md](deploy/z3/MINING.md), along with
everything else about running it.

```bash
systemctl status zcash-testnet-miner
journalctl -u zcash-testnet-miner -f
```

Mode lives in `/etc/faucet/miner.env`. `MINER_MODE=proposal` (the default the
service ships with) solves and validates through `getblocktemplate
mode=proposal` and submits nothing. That is the safety gate.
`MINER_MODE=submit` goes live, flip it only after a proposal run reports
`proposal VALID`, and coordinate the first live submission. Two more things
worth knowing at 3am: "no solution in this window" in the log is normal, and
a won block pays a transparent coinbase that needs 100 confirmations plus a
shielding step before the faucet balance moves.

## Monitoring and alerts

Alerts push, metrics pull. Both are covered in
[deploy/z3/OBSERVABILITY.md](deploy/z3/OBSERVABILITY.md).

- The watchdog posts to the webhook in `/etc/faucet/watchdog.env`
  (`WATCHDOG_ALERT_URL`, format `slack` or `discord`) when the faucet has
  been un-ready past the grace window, once per episode, and again on
  recovery. It also alerts when it recovers or restarts a container.
- `faucet-metrics.sh` writes `/var/lib/node_exporter/textfile/faucet.prom`
  every 30 seconds: readiness, balance, queue depth, sync state, container
  states. If `faucet_metrics_scrape_timestamp` stops advancing, the collector
  died and the other numbers are stale.

## Faucet is not ready, now what

Ordered by the `/api/ready` reason. Start with the reason itself:

```bash
curl -s "https://$(cat /etc/faucet-domain)/api/ready" | jq
# or hit the app the way the watchdog does (WATCHDOG_FAUCET_URL in
# /etc/faucet/watchdog.env, the overlay does not publish :3000 on the host)
```

1. **No answer at all** (curl fails, or `/api/health` is dead). This is a
   liveness problem, not readiness. The watchdog should already be
   restarting the web container, check `journalctl -u faucet-watchdog` and
   `docker ps`. If caddy is up but the app is not, `docker logs` the faucet
   container. If nothing docker is running, start both stacks per the
   start/stop section.
2. **`backend unreachable`.** The read-side light client endpoint
   (`LIGHTWALLETD_ENDPOINT` in `deploy/z3/faucet.env`, a public Zaino by
   default) is not answering. Check outbound network from the box, and if it
   points at a self-hosted `zaino` container, check that container. Sending
   goes through zallet and does not use this path, so this blocks lookups
   and readiness, not the wallet itself.
3. **`node syncing`.** Zebra is catching up. Normal after a fresh box,
   restore or long downtime, and the watchdog deliberately does not page
   during it. Watch progress in the metrics file or
   `docker logs -f <zebra container>`. Nothing to fix, only to wait, unless
   it is stuck, then look at zebra's logs and disk space.
4. **`wallet balance unknown`.** Zallet did not answer. It is known to exit
   when zebra closes the mempool stream, the watchdog docker-starts it
   again within a sweep. If it is crash-looping instead, read
   `docker logs <zallet container>` and check the RPC auth in
   `z3-stack/config/testnet/zallet.toml` matches `faucet.env`.
5. **`below reserve, refilling`.** Not broken, broke. **Fund the faucet
   address.** That is the fix, not a fallback. Mining lands a block rarely
   enough that it is not the answer at 3am, and even a block won right now
   needs 100 confirmations plus a shielding step before the balance moves, so
   it is never the fast path
   back. Confirm with `curl -s .../api/status`.

If the reason is none of these and the site is dark to users, check
certificates and DNS per [deploy/z3/HTTPS.md](deploy/z3/HTTPS.md), and as a
last resort re-run `deploy/deploy.sh`, which is safe to repeat.
