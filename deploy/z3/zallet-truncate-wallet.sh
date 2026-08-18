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
# It stops zallet, backs up wallet.db, truncates, and starts zallet again.
set -uo pipefail

MAX_HEIGHT="${1:-}"
case "$MAX_HEIGHT" in
  ''|*[!0-9]*)
    echo "usage: $0 <MAX_HEIGHT>   a block height just below the conflict, e.g. 4282400" >&2
    exit 2 ;;
esac

ZALLET_CONTAINER="${ZALLET_CONTAINER:-z3-testnet-zallet-1}"
VOLUME="${ZALLET_VOLUME:-z3-testnet-zallet}"
IMAGE="${ZALLET_IMAGE:-zodlinc/zallet:v0.1.0-beta.1}"
DATADIR="${ZALLET_DATADIR:-/var/lib/zallet}"
CONFIG="${ZALLET_CONFIG:-/etc/zallet/zallet.toml}"
DB="/var/lib/docker/volumes/${VOLUME}/_data/wallet.db"

[ -f "$DB" ] || { echo "ABORT: no wallet.db at $DB" >&2; exit 1; }

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
