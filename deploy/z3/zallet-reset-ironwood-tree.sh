#!/usr/bin/env bash
# Empty the Ironwood note-commitment tree tables so a rescan rebuilds them from scratch.
# This clears a residual/corrupt Ironwood shardtree WITHOUT touching the account keys or
# the seed - only the derived commitment-tree state.
#
# WHY THIS EXISTS. `zallet repair truncate-wallet <birthday>` rewinds the scan state but
# leaves a small residual Ironwood frontier (on 2026-08-30: 1 shard + 3 checkpoints at the
# birthday height). That residual is the "existing root" a beta.3 boot conflicts with:
#
#     Failed to synchronize zallet: Inserted root conflicts with existing root
#       at address Address { level: Level(0), index: 2 }
#
# Truncate cannot go below the birthday, so it cannot clear that last frontier. Emptying
# the Ironwood tree tables does, and because the wallet is ALREADY truncated to birthday
# (scan reset), the rescan rebuilds the tree from empty with no residual to conflict with.
#
# SAFE FOR FUNDS. It deletes only the *_tree_* tables for the Ironwood pool - the derived
# commitment tree, not notes, not keys, not the seed. Every Ironwood note re-derives from
# the seed on the rescan (the chain is the source of truth). Sapling and Orchard trees are
# left alone; only Ironwood was corrupt.
#
# PRECONDITION: run `zallet repair truncate-wallet <birthday>` first (or confirm the wallet
# is already reset to birthday), so the scan state and the emptied tree agree. Emptying the
# tree without resetting the scan would leave the wallet believing it scanned blocks whose
# tree it no longer has.
#
# Usage (on the box):
#     systemctl stop faucet-watchdog.service
#     docker stop z3-testnet-zallet-1
#     bash deploy/z3/zallet-reset-ironwood-tree.sh
#     docker start z3-testnet-zallet-1
#     systemctl start faucet-watchdog.service
set -uo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

ZALLET_CONTAINER="${ZALLET_CONTAINER:-z3-testnet-zallet-1}"
VOLUME="${ZALLET_VOLUME:-z3-testnet-zallet}"
DB="/var/lib/docker/volumes/${VOLUME}/_data/wallet.db"

[ -f "$DB" ] || { echo "ABORT: no wallet.db at $DB" >&2; exit 1; }
if [ "$(docker inspect -f '{{.State.Running}}' "$ZALLET_CONTAINER" 2>/dev/null)" = "true" ]; then
  echo "ABORT: $ZALLET_CONTAINER is running. Stop it first, or sqlite and the wallet fight over wallet.db." >&2
  exit 1
fi

sq() { docker run --rm -v "$VOLUME":/d alpine:3 sh -c "apk add -q sqlite 2>/dev/null; sqlite3 /d/wallet.db \"\$1\"" _ "$1"; }

# The five Ironwood shardtree tables. Bare counts, no string literals in the SQL: it
# crosses a docker sh -c boundary and a label inside it arrives at sqlite as an identifier.
COUNTS='select (select count(*) from ironwood_tree_shards), (select count(*) from ironwood_tree_checkpoints), (select count(*) from ironwood_tree_cap), (select count(*) from ironwood_tree_checkpoint_marks_removed), (select count(*) from ironwood_tree_retained_checkpoints), (select count(*) from accounts);'
# shellcheck disable=SC2086  # deliberate split into label's positional args
label() { echo "shards=$1 checkpoints=$2 cap=$3 marks_removed=$4 retained=$5 accounts(keys)=$6"; }

BEFORE="$(sq "$COUNTS" | tr '|' ' ')"
# shellcheck disable=SC2086
echo "before: $(label $BEFORE)"

if [ "$DRY_RUN" = "1" ]; then
  echo "--dry-run: would empty the five ironwood_tree_* tables; accounts/keys/seed untouched"
  exit 0
fi

BAK="${DB}.bak-ironwoodreset-$(date +%s)"
cp -f "$DB" "$BAK" && echo "backup: $BAK"

sq "delete from ironwood_tree_shards;
    delete from ironwood_tree_checkpoints;
    delete from ironwood_tree_cap;
    delete from ironwood_tree_checkpoint_marks_removed;
    delete from ironwood_tree_retained_checkpoints;"

AFTER="$(sq "$COUNTS" | tr '|' ' ')"
# shellcheck disable=SC2086
echo "after:  $(label $AFTER)"
echo "integrity: $(sq 'pragma integrity_check;')"
FK="$(sq 'pragma foreign_key_check;')"
echo "foreign_key_check: ${FK:-clean}"
echo
echo "accounts/keys row count is UNCHANGED above - the seed was not touched."
echo "done. start zallet:  docker start $ZALLET_CONTAINER"
echo "It re-scans from the birthday and rebuilds the Ironwood tree from empty, with no"
echo "residual 'existing root' to conflict with."
