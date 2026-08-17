#!/usr/bin/env bash
# Abandon transactions that expired without ever being mined, which crash-loop zallet.
#
# THIS ONE TOUCHES MONEY RECORDS. That is why it is a separate file from
# zallet-drop-unfetchable-queue.sh rather than another phase inside it: a tool that
# deletes rows which cascade into sent_notes and received notes must say so in its name,
# so nobody reaches for it casually during an incident.
#
# WHAT IT FIXES. zallet computes a status request for every transaction still carrying
# mined_height IS NULL, independently of the retrieval queues. For a transaction that
# expired unmined and that zebra has since dropped, the answer is
#
#     RPC Error (code: -5): No such mempool or main chain transaction
#
# zaino classifies that UNRECOVERABLE instead of not-found, zallet exits, and the restart
# policy serves the identical death forever. On 2026-08-17 that was 162 restarts and ~10
# hours of `wallet balance unknown`. Cleaning both queues first was NOT enough - the
# requests come from the transaction rows themselves, so those are what must go.
#
# WHY DELETING IS RIGHT, not merely tolerable. An expired, never-mined transaction did not
# happen. Abandoning it is what every wallet does with one, and it makes the wallet MORE
# accurate, in both directions:
#
#   sent_notes            the real notes this transaction tried to spend. Removing them
#                         releases those notes, which are currently stuck behind a send
#                         that can never confirm. Funds come BACK.
#   received notes        change the wallet expected from its own failed send. It never
#                         existed on chain, so it is phantom, and removing it CORRECTS a
#                         balance that was overstated.
#
# Nothing real is lost either way: the chain is the source of truth and the wallet holds
# the seed, so any genuine output is recoverable by rescanning.
#
# IT REFUSES TO GUESS. A transaction is only a candidate when all three hold:
#   1. mined_height IS NULL          - never made it into a block
#   2. expiry_height < tip - MARGIN  - definitively past expiry, not merely pending
#   3. zebra cannot serve it         - checked live, per transaction
# and it aborts if the node is not answering at all, because an unreachable node is not
# proof a transaction is gone. A transaction that is unmined but still fetchable, or whose
# expiry is anywhere near the tip, is left alone.
#
# Usage (on the box):
#     systemctl stop faucet-watchdog.service      # or it restarts zallet mid-repair
#     docker stop z3-testnet-zallet-1
#     bash deploy/z3/zallet-abandon-expired-txs.sh --dry-run
#     bash deploy/z3/zallet-abandon-expired-txs.sh
#     docker start z3-testnet-zallet-1
#     systemctl start faucet-watchdog.service
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

ZALLET_CONTAINER="${ZALLET_CONTAINER:-z3-testnet-zallet-1}"
ZEBRA_CONTAINER="${ZEBRA_CONTAINER:-z3-testnet-zebra-1}"
NET="${Z3_NETWORK:-z3-testnet}"
VOLUME="${ZALLET_VOLUME:-z3-testnet-zallet}"
# How far below the tip an expiry must sit before we call it settled. 100 blocks is far
# past any reorg that could still mine it, and keeps a just-expired send off the list.
MARGIN="${EXPIRY_MARGIN:-100}"

sq() { docker run --rm -v "$VOLUME":/d alpine:3 sh -c "apk add -q sqlite 2>/dev/null; sqlite3 /d/wallet.db \"\$1\"" _ "$1"; }

if [ "$(docker inspect -f '{{.State.Running}}' "$ZALLET_CONTAINER" 2>/dev/null)" = "true" ]; then
  echo "ABORT: $ZALLET_CONTAINER is running. Stop it first, or sqlite and the wallet will fight over wallet.db." >&2
  exit 1
fi

COOKIE="$(docker exec "$ZEBRA_CONTAINER" cat /run/auth/.cookie 2>/dev/null || true)"
[ -n "$COOKIE" ] || { echo "ABORT: could not read zebra's rpc cookie" >&2; exit 1; }

rpc() {
  docker run --rm --network "$NET" curlimages/curl:latest -s --max-time 10 -u "$COOKIE" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "http://zebra:18232/" 2>/dev/null
}

TIP="$(rpc getblockcount '[]' | grep -oE '"result":[0-9]+' | cut -d: -f2)"
[ -n "$TIP" ] || { echo "ABORT: zebra is not answering getblockcount. An unreachable node is not proof a transaction is gone." >&2; exit 1; }
CUTOFF=$(( TIP - MARGIN ))
echo "zebra tip: $TIP   abandoning only expiry < $CUTOFF"

CANDIDATES="$(sq "select id_tx || ':' || hex(txid) from transactions where mined_height is null and expiry_height > 0 and expiry_height < $CUTOFF;" | tr -d '\r')"
[ -n "$CANDIDATES" ] || { echo "nothing to do: no settled expired unmined transactions"; exit 0; }
echo "candidates: $(echo "$CANDIDATES" | wc -l | tr -d ' ')"

DEAD_IDS=()
for ROW in $CANDIDATES; do
  ID="${ROW%%:*}"; HX="${ROW#*:}"
  LOWER="$(echo "$HX" | tr 'A-F' 'a-f')"
  if rpc getrawtransaction "[\"$LOWER\"]" | grep -q '"error":null'; then
    echo "  id=$ID ${HX:0:12}… zebra still has it, leaving alone"
  else
    echo "  id=$ID ${HX:0:12}… gone from the chain, abandoning"
    DEAD_IDS+=("$ID")
  fi
done

[ "${#DEAD_IDS[@]}" -gt 0 ] || { echo "nothing to do: every expired transaction is still fetchable"; exit 0; }

# Bare counts, no string literals: the SQL crosses a docker sh -c boundary and a label
# inside it arrives at sqlite as an identifier.
COUNTS_Q='select (select count(*) from transactions), (select count(*) from sent_notes), (select count(*) from ironwood_received_notes), (select count(*) from orchard_received_notes), (select count(*) from sapling_received_notes), (select count(*) from transparent_received_outputs), (select count(*) from tx_retrieval_queue), (select count(*) from transparent_spend_search_queue);'
label() { echo "transactions=$1 sent_notes=$2 ironwood=$3 orchard=$4 sapling=$5 transparent_outputs=$6 retrieval_q=$7 spend_q=$8"; }

if [ "$DRY_RUN" = "1" ]; then
  echo; echo "before: $(label $(sq "$COUNTS_Q" | tr '|' ' '))"
  echo "--dry-run: would abandon ${#DEAD_IDS[@]} transaction(s), nothing changed"
  exit 0
fi

BAK="/var/lib/docker/volumes/${VOLUME}/_data/wallet.db.bak-abandon-$(date +%s)"
cp -f "/var/lib/docker/volumes/${VOLUME}/_data/wallet.db" "$BAK"
echo "backup: $BAK"

echo "before: $(label $(sq "$COUNTS_Q" | tr '|' ' '))"
IDLIST="$(printf '%s,' "${DEAD_IDS[@]}")"; IDLIST="${IDLIST%,}"
# foreign_keys=ON so the declared ON DELETE CASCADE actually fires. Without it sqlite
# leaves dangling children and the wallet reads a note whose transaction is gone.
sq "pragma foreign_keys=ON; delete from transactions where id_tx in ($IDLIST);"
echo "after:  $(label $(sq "$COUNTS_Q" | tr '|' ' '))"
echo "integrity: $(sq 'pragma integrity_check;')"
FK="$(sq 'pragma foreign_key_check;')"
echo "foreign_key_check: ${FK:-clean}"
echo
echo "done. start zallet:  docker start $ZALLET_CONTAINER"
echo "Expect ONE more crash on the boot already in flight, then recovery - read the"
echo "NEWEST log and 'docker ps', not the first crash in the scrollback."
