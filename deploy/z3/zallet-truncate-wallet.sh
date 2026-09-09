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
# It stops zallet, backs up wallet.db, truncates, and starts zallet again, running the
# exact image the zallet container runs (the image ID, not the tag, which can move under
# a running container). The container must EXIST, stopped is fine: --volumes-from needs
# it. ZALLET_IMAGE overrides the image for a container whose inspect you do not trust;
# ZALLET_WALLET_DB overrides the db path, for the suite. The watchdog must be stopped
# first and the script refuses if it is not: it would docker-start zallet mid-repair.
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
WATCHDOG_UNIT="${ZALLET_REPAIR_WATCHDOG_UNIT:-faucet-watchdog.service}"
if [ "$(systemctl is-active "$WATCHDOG_UNIT" 2>/dev/null || true)" = "active" ]; then
  echo "ABORT: $WATCHDOG_UNIT is active and would docker-start zallet mid-repair. Run: systemctl stop $WATCHDOG_UNIT   (and start it again after). Nothing was stopped." >&2
  exit 1
fi

# THE CONTAINER MUST EXIST: --volumes-from needs it (stopped is fine, removed is not),
# and it is where the image comes from. Its stderr is shown, because "no such container",
# "permission denied on the socket" and "daemon not running" want three different fixes.
inspect_err="$(mktemp)"
container_name="$(docker inspect --format '{{.Config.Image}}' "$ZALLET_CONTAINER" 2>"$inspect_err")" || container_name=""
container_id_image="$(docker inspect --format '{{.Image}}' "$ZALLET_CONTAINER" 2>/dev/null)" || container_id_image=""
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
case "$container_name" in
  *zallet*) ;;
  *) echo "ABORT: container $ZALLET_CONTAINER runs \"$container_name\", which does not look like a zallet image. Nothing was stopped." >&2; exit 1 ;;
esac
if [ -n "${ZALLET_IMAGE:-}" ]; then
  # An override for a container whose image you do not trust. It still has to be a zallet
  # by name, or a bare ID or digest, which carry no name and are taken as given.
  case "$ZALLET_IMAGE" in
    *zallet*|sha256:*|*@sha256:*) ;;
    *) echo "ABORT: ZALLET_IMAGE \"$ZALLET_IMAGE\" is neither a zallet image by name nor an image ID or digest. Nothing was stopped." >&2; exit 1 ;;
  esac
  IMAGE="$ZALLET_IMAGE"
  echo "image: $IMAGE (from ZALLET_IMAGE, an override you set; the container runs $container_name = $container_id_image)"
else
  IMAGE="$container_id_image"
  echo "image: $container_name, running as $IMAGE (from the container $ZALLET_CONTAINER; the ID is what runs, the tag is a name)"
fi

echo "=== stop zallet (the daemon must not hold wallet.db during a truncate) ==="
docker stop "$ZALLET_CONTAINER" >/dev/null 2>&1 || true

BAK="${DB}.bak-pretruncate-$(date +%s)"
if cp -f "$DB" "$BAK"; then
  echo "backup: $BAK"
else
  echo "ABORT: could not back up $DB to $BAK (disk full?). No truncate without a backup." >&2
  docker start "$ZALLET_CONTAINER" >/dev/null 2>&1 && echo "zallet started again on the untouched state"
  exit 1
fi

echo "=== truncate wallet to at most ${MAX_HEIGHT} ==="
# --volumes-from reuses the exact volumes and config the container had, so this opens the
# same encrypted wallet with the same identity - no config drift, nothing to mount by hand.
# No network: a truncate is a local data-store operation and must not depend on the node.
docker run --rm --volumes-from "$ZALLET_CONTAINER" --network none "$IMAGE" \
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
  exit "$rc"
fi

echo
echo "done. Watch it re-scan PAST the conflict height to the node tip:"
echo "  docker logs -f --tail 5 $ZALLET_CONTAINER"
echo "Expect a clean sync from ~${MAX_HEIGHT} up to the tip with no more"
echo "PutBlocksCommitmentTree conflict, then the faucet reports ready."
