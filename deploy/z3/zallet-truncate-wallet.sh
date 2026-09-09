#!/usr/bin/env bash
# Truncate the wallet to below a note-commitment-tree conflict, so a re-scan rebuilds the
# tree cleanly. This is the repair for a zallet crash-loop whose signature is:
#
#     Wallet ... sync task exited ... PutBlocksCommitmentTree { pool: <P>,
#       block_range: H..H+n, error: Insert(Conflict(Address { ... })) }
#
# DIFFERENT FROM THE DROPPED-TX POISON (zallet-abandon-expired-txs.sh). That one is a bad
# transaction row the node can no longer serve. This one is a shardtree that disagrees
# with the notes at height H: every re-scan reaches H, tries to insert the commitment-tree
# node, hits the conflict, and the sync task dies. zallet exits, restarts, re-scans to H,
# dies the same way - a loop that pins the wallet height at H forever, so the faucet never
# reaches "synced". 2026-08-18: abandoning dropped txs left the Ironwood tree inconsistent
# at block 4282502 and the wallet stuck exactly there.
#
# zallet ships the fix: `repair truncate-wallet <H>` rewinds the data store to at most H
# (it may pick a lower height if H has no witness), and `zallet start` then re-syncs from
# there, rebuilding the tree. Nothing real is lost: the chain is the source of truth and
# the wallet holds the seed, so every note re-derives on the re-scan. Pass a height a
# little BELOW the conflict's block_range (read it off the log line above).
#
# Usage (on the box):
#     systemctl stop faucet-watchdog.service      # or it restarts zallet mid-repair
#     bash deploy/z3/zallet-truncate-wallet.sh <MAX_HEIGHT>
#     systemctl start faucet-watchdog.service
# It stops zallet, confirms it is down, backs up wallet.db with its -wal/-shm sidecars,
# truncates, and starts zallet again, running the exact image and user the zallet
# container runs (the image ID, not the tag, which can move under a running container).
# The container must EXIST, stopped is fine: --volumes-from needs it. ZALLET_IMAGE
# overrides the image (a zallet name, an image ID or a digest) for a container whose
# inspect you do not trust; ZALLET_WALLET_DB overrides the db path, for the suite. The
# watchdog must be stopped first and the script refuses unless it is definitely down:
# it would docker-start zallet mid-repair. Start it again afterwards; the script says so.
# Truncate is not always the whole fix: see zallet-reset-ironwood-tree.sh for the
# Ironwood frontier conflict a beta.3 wallet can hit afterwards.
set -uo pipefail

MAX_HEIGHT="${1:-}"
case "$MAX_HEIGHT" in
  ''|*[!0-9]*)
    echo "usage: $0 <MAX_HEIGHT>   a block height just below the conflict, e.g. 4282400" >&2
    exit 2 ;;
esac

ZALLET_CONTAINER="${ZALLET_CONTAINER:-z3-testnet-zallet-1}"
VOLUME="${ZALLET_VOLUME:-z3-testnet-zallet}"
DATADIR="${ZALLET_DATADIR:-/var/lib/zallet}"
CONFIG="${ZALLET_CONFIG:-/etc/zallet/zallet.toml}"
DB="${ZALLET_WALLET_DB:-/var/lib/docker/volumes/${VOLUME}/_data/wallet.db}"

[ -f "$DB" ] || { echo "ABORT: no wallet.db at $DB" >&2; exit 1; }

# THE WATCHDOG MUST BE STOPPED FIRST. Its container sweep docker-starts a zallet it finds
# not running, which is two writers on wallet.db while the truncate has it open. The
# usage comment said so; a comment is not a guard.
# FAIL CLOSED: only a definite inactive or failed passes. "activating" is a watchdog in
# its Restart=always loop that will sweep in seconds; "unknown", a mistyped unit name or
# no systemctl at all are "could not tell", and a repair of the funds db does not proceed
# on could-not-tell.
WATCHDOG_UNIT="${ZALLET_REPAIR_WATCHDOG_UNIT:-faucet-watchdog.service}"
wd_state="$(systemctl is-active "$WATCHDOG_UNIT" 2>/dev/null || true)"
case "$wd_state" in
  inactive|failed) ;;
  active|activating|reloading|deactivating)
    echo "ABORT: $WATCHDOG_UNIT is $wd_state and would docker-start zallet mid-repair. Run: systemctl stop $WATCHDOG_UNIT   (and systemctl start it again after the repair). Nothing was stopped." >&2
    exit 1 ;;
  *)
    echo "ABORT: could not tell whether $WATCHDOG_UNIT is running (systemctl said \"${wd_state:-nothing}\"). Check the unit name (ZALLET_REPAIR_WATCHDOG_UNIT) and that systemctl works here. Nothing was stopped." >&2
    exit 1 ;;
esac

# THE CONTAINER MUST EXIST: --volumes-from needs it (stopped is fine, removed is not),
# and it is where the image comes from. Its stderr is shown, because "no such container",
# "permission denied on the socket" and "daemon not running" want three different fixes.
inspect_err="$(mktemp)"
container_name="$(docker inspect --format '{{.Config.Image}}' "$ZALLET_CONTAINER" 2>"$inspect_err")" || container_name=""
container_id_image="$(docker inspect --format '{{.Image}}' "$ZALLET_CONTAINER" 2>>"$inspect_err")" || container_id_image=""
# The identity the container runs as: --volumes-from carries mounts, not user or env, so
# a repair run as root would leave root-owned files in a volume the daemon opens as its
# own uid. Empty means the image default, which is what the container got too.
container_user="$(docker inspect --format '{{.Config.User}}' "$ZALLET_CONTAINER" 2>>"$inspect_err")" || container_user=""
if [ -z "$container_name" ] || [ -z "$container_id_image" ]; then
  echo "ABORT: could not inspect container $ZALLET_CONTAINER: $(tr '\n' ' ' < "$inspect_err")" >&2
  echo "  The repair mounts that container's volumes and runs the zallet it runs, so it has to exist (stopped is fine)." >&2
  echo "  Fix the name (ZALLET_CONTAINER), the docker socket, or bring the container back with compose. Nothing was stopped." >&2
  rm -f "$inspect_err"; exit 1
fi
rm -f "$inspect_err"

# THE IMAGE IS THE ONE THE WALLET RUNS: the image ID (.Image), never a pin in this file
# and never the tag name (.Config.Image) either, because a tag can be re-pushed or
# re-tagged under a running container and then names a different binary than the one
# holding wallet.db. The pin here was v0.1.0-beta.1 while the wallet had moved to beta.3
# (risk register #14). The NAME is checked and logged, so a container that is not a
# zallet is refused with a word a human can read, and the ID is what runs.
# A name is checked for the word; a bare ID or digest carries no name and is taken as
# the exact reference it is (docker accepts sha256:<id>, the bare hex, and name@sha256:).
looks_like_zallet() { case "$1" in *zallet*|sha256:*|*@sha256:*) return 0 ;; esac; printf '%s' "$1" | grep -qE '^[0-9a-f]{12,64}$'; }
if [ -n "${ZALLET_IMAGE:-}" ]; then
  # An override for a container whose image you do not trust, so the container's own name
  # is reported, not judged; the override itself has to look like a zallet or an ID.
  looks_like_zallet "$ZALLET_IMAGE" || { echo "ABORT: ZALLET_IMAGE \"$ZALLET_IMAGE\" is neither a zallet image by name nor an image ID or digest. Nothing was stopped." >&2; exit 1; }
  IMAGE="$ZALLET_IMAGE"
  echo "image: $IMAGE (from ZALLET_IMAGE, an override you set; the container runs $container_name = $container_id_image)"
else
  looks_like_zallet "$container_name" || { echo "ABORT: container $ZALLET_CONTAINER runs \"$container_name\", which does not look like a zallet image. Set ZALLET_IMAGE if you know better. Nothing was stopped." >&2; exit 1; }
  IMAGE="$container_id_image"
  echo "image: $container_name, running as $IMAGE (from the container $ZALLET_CONTAINER; the ID is what runs, the tag is a name)"
fi
[ -z "$container_user" ] || echo "user: $container_user (the container's, so the repair writes as the daemon does)"

echo "=== stop zallet (the daemon must not hold wallet.db during a truncate) ==="
docker stop "$ZALLET_CONTAINER" >/dev/null 2>&1 || true
# CONFIRM IT IS DOWN before opening the db beside it. A stop that did not take, or a
# sweep that started it back, is two writers on wallet.db; the sibling repair
# (zallet-reset-ironwood-tree.sh) refuses on the same check.
running="$(docker inspect --format '{{.State.Running}}' "$ZALLET_CONTAINER" 2>/dev/null || echo unknown)"
if [ "$running" != "false" ]; then
  echo "ABORT: $ZALLET_CONTAINER is still running (State.Running=$running) after docker stop, so the truncate would open wallet.db beside a live daemon. Nothing was changed." >&2
  exit 1
fi

# THE BACKUP IS THE WHOLE DATABASE: wallet.db AND its -wal and -shm sidecars when they
# exist. A crash-looping wallet, which is what this repair is for, is exactly the case
# with a populated write-ahead log; a copy of the main file alone restores a database
# missing its last writes (restore-backup.sh learned this the hard way, #216).
stamp="$(date +%s)"
BAK="${DB}.bak-pretruncate-${stamp}"
backup_ok=1
cp -f "$DB" "$BAK" || backup_ok=0
for side in wal shm; do
  if [ -f "${DB}-${side}" ]; then cp -f "${DB}-${side}" "${BAK}-${side}" || backup_ok=0; fi
done
if [ "$backup_ok" = "1" ]; then
  echo "backup: $BAK$( [ -f "${BAK}-wal" ] && printf ' (+ -wal%s)' "$( [ -f "${BAK}-shm" ] && printf ', -shm')" )"
  echo "  to put it back: docker stop $ZALLET_CONTAINER; cp -f $BAK $DB; rm -f ${DB}-wal ${DB}-shm; [ -f ${BAK}-wal ] && cp -f ${BAK}-wal ${DB}-wal; [ -f ${BAK}-shm ] && cp -f ${BAK}-shm ${DB}-shm; docker start $ZALLET_CONTAINER"
else
  echo "ABORT: could not back up $DB (and sidecars) to $BAK (disk full?). No truncate without a backup." >&2
  rm -f "$BAK" "${BAK}-wal" "${BAK}-shm"
  docker start "$ZALLET_CONTAINER" >/dev/null 2>&1 && echo "zallet started again on the untouched state"
  exit 1
fi

echo "=== truncate wallet to at most ${MAX_HEIGHT} ==="
# --volumes-from reuses the exact volumes and config the container had, so this opens the
# same encrypted wallet with the same identity - no config drift, nothing to mount by hand.
# No network: a truncate is a local data-store operation and must not depend on the node.
# --user only when the container has one, so the repair writes as the daemon does.
user_args=()
[ -z "$container_user" ] || user_args=(--user "$container_user")
docker run --rm --volumes-from "$ZALLET_CONTAINER" --network none "${user_args[@]}" "$IMAGE" \
  --datadir "$DATADIR" --config "$CONFIG" \
  repair truncate-wallet "$MAX_HEIGHT"
rc=$?

echo "=== restart zallet ==="
if docker start "$ZALLET_CONTAINER" >/dev/null 2>&1; then
  restarted="zallet was started again"
else
  restarted="AND zallet could NOT be started again (docker start $ZALLET_CONTAINER failed), start it by hand"
  echo "WARNING: $restarted" >&2
fi

if [ "$rc" -ne 0 ]; then
  echo "TRUNCATE FAILED (exit $rc). wallet.db backup is $BAK; $restarted, on the pre-truncate state." >&2
  echo "Then: systemctl start $WATCHDOG_UNIT   (you stopped it for this; self-healing is off until it runs)" >&2
  exit "$rc"
fi

echo
echo "done. Watch it re-scan PAST the conflict height to the node tip:"
echo "  docker logs -f --tail 5 $ZALLET_CONTAINER"
echo "Expect a clean sync from ~${MAX_HEIGHT} up to the tip with no more"
echo "PutBlocksCommitmentTree conflict, then the faucet reports ready."
echo "If a beta.3 wallet then dies on an Ironwood frontier conflict, the next step is"
echo "zallet-reset-ironwood-tree.sh (its header names this truncate as its precondition)."
echo "Now: systemctl start $WATCHDOG_UNIT   (you stopped it for this; self-healing is off until it runs)"
