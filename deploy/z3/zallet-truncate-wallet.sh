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
# It stops zallet, backs up wallet.db, truncates, and starts zallet again, using the
# image the zallet container is running (ZALLET_IMAGE overrides, for a container that
# is gone; ZALLET_WALLET_DB overrides the db path, for the suite).
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

# THE IMAGE IS THE ONE THE WALLET RUNS, read off the container, never a pin in this file.
# The pin here was v0.1.0-beta.1 while the wallet had moved to beta.3, so the mid-incident
# repair would have opened the funds database with an older schema handler (risk register
# #14). A repair tool that cannot tell which zallet owns the file has no business touching
# it: no readable image, no truncate. ZALLET_IMAGE still overrides, for a wallet whose
# container is gone, and says so in the log so the choice is on record.
if [ -n "${ZALLET_IMAGE:-}" ]; then
  IMAGE="$ZALLET_IMAGE"; image_from="ZALLET_IMAGE (an override you set, not the running container)"
else
  IMAGE="$(docker inspect --format '{{.Config.Image}}' "$ZALLET_CONTAINER" 2>/dev/null)" || IMAGE=""
  image_from="the running container $ZALLET_CONTAINER"
  if [ -z "$IMAGE" ]; then
    echo "ABORT: could not read the image of container $ZALLET_CONTAINER (docker inspect gave nothing)." >&2
    echo "  The repair must run the SAME zallet that owns wallet.db. Fix the container name (ZALLET_CONTAINER)," >&2
    echo "  or, if the container is gone, set ZALLET_IMAGE to the exact image it ran. Nothing was stopped." >&2
    exit 1
  fi
fi
case "$IMAGE" in
  *zallet*) ;;
  *) echo "ABORT: image \"$IMAGE\" from $image_from does not look like a zallet image. Nothing was stopped." >&2; exit 1 ;;
esac
echo "image: $IMAGE (from $image_from)"

echo "=== stop zallet (the daemon must not hold wallet.db during a truncate) ==="
docker stop "$ZALLET_CONTAINER" >/dev/null 2>&1 || true

BAK="${DB}.bak-pretruncate-$(date +%s)"
cp -f "$DB" "$BAK" && echo "backup: $BAK"

echo "=== truncate wallet to at most ${MAX_HEIGHT} ==="
# --volumes-from reuses the exact volumes and config the container had, so this opens the
# same encrypted wallet with the same identity - no config drift, nothing to mount by hand.
# No network: a truncate is a local data-store operation and must not depend on the node.
docker run --rm --volumes-from "$ZALLET_CONTAINER" --network none "$IMAGE" \
  --datadir "$DATADIR" --config "$CONFIG" \
  repair truncate-wallet "$MAX_HEIGHT"
rc=$?

echo "=== restart zallet ==="
docker start "$ZALLET_CONTAINER" >/dev/null 2>&1 && echo "started"

if [ "$rc" -ne 0 ]; then
  echo "TRUNCATE FAILED (exit $rc). wallet.db backup is $BAK, and zallet was restarted on the pre-truncate state." >&2
  exit "$rc"
fi

echo
echo "done. Watch it re-scan PAST the conflict height to the node tip:"
echo "  docker logs -f --tail 5 $ZALLET_CONTAINER"
echo "Expect a clean sync from ~${MAX_HEIGHT} up to the tip with no more"
echo "PutBlocksCommitmentTree conflict, then the faucet reports ready."
