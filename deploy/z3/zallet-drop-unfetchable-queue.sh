#!/usr/bin/env bash
# Drop the tx_retrieval_queue rows whose transactions zebra can no longer serve, which
# crash-loop zallet.
#
# THE SECOND SHAPE OF THE #430 BUG, in a different table. zallet-drop-orphan-txs.py
# cleans `transactions` rows with raw IS NULL. This cleans `tx_retrieval_queue`: the
# work list of txids zallet still wants bytes for. On boot it asks zebra for each one,
# and for a transaction that expired unmined and has since been dropped it gets
#
#     RPC Error (code: -5): No such mempool or main chain transaction
#
# zaino classifies that UNRECOVERABLE rather than "not found", zallet exits, and the
# restart policy feeds it the identical death forever. Same non-self-healing shape as
# #430: the input that kills it is stored state, so nothing outside the database can
# recover it.
#
# 2026-08-17: 162 restarts, ~10 hours of `wallet balance unknown` and a gated faucet.
# The orphan script ran clean (12 rows, 0 references) and it STILL crash-looped, because
# all five poison rows were in this table and it does not look here.
#
# WHY DELETING THESE IS SAFE, and it is a different argument to the orphan script's:
# this is a WORK QUEUE, not a record of money. Its only foreign key points OUT
# (dependent_transaction_id -> transactions ON DELETE CASCADE), so deleting a queue row
# cannot cascade into transactions, notes or balances. If the wallet still needs the
# data it re-enqueues on the next scan. Nothing here is a note, a spend or an amount.
#
# It still refuses to guess: every candidate is CHECKED AGAINST THE LIVE NODE first and
# only rows zebra actually cannot serve are deleted. A queue row for a transaction zebra
# has is a row that would have succeeded, and this script leaves it alone.
#
# Usage (on the box; stop zallet first or sqlite and the wallet fight over the file):
#     docker stop z3-testnet-zallet-1
#     bash deploy/z3/zallet-drop-unfetchable-queue.sh
#     docker start z3-testnet-zallet-1
#
# Add --dry-run to see what it would do and change nothing.
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

ZALLET_CONTAINER="${ZALLET_CONTAINER:-z3-testnet-zallet-1}"
ZEBRA_CONTAINER="${ZEBRA_CONTAINER:-z3-testnet-zebra-1}"
NET="${Z3_NETWORK:-z3-testnet}"
VOLUME="${ZALLET_VOLUME:-z3-testnet-zallet}"
DB_IN_VOL="/d/wallet.db"

# sqlite and curl come from throwaway containers so this needs nothing installed on the
# host, matching how the rest of deploy/z3 works.
sq() { docker run --rm -v "$VOLUME":/d alpine:3 sh -c "apk add -q sqlite 2>/dev/null; sqlite3 $DB_IN_VOL \"\$1\"" _ "$1"; }

if [ "$(docker inspect -f '{{.State.Running}}' "$ZALLET_CONTAINER" 2>/dev/null)" = "true" ]; then
  echo "ABORT: $ZALLET_CONTAINER is running. Stop it first, or sqlite and the wallet will fight over wallet.db." >&2
  exit 1
fi

COOKIE="$(docker exec "$ZEBRA_CONTAINER" cat /run/auth/.cookie 2>/dev/null || true)"
[ -n "$COOKIE" ] || { echo "ABORT: could not read zebra's rpc cookie from $ZEBRA_CONTAINER:/run/auth/.cookie" >&2; exit 1; }

rpc() { # $1=method $2=json params
  docker run --rm --network "$NET" curlimages/curl:latest -s --max-time 10 -u "$COOKIE" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "http://zebra:18232/" 2>/dev/null
}

# Prove the node is answering BEFORE concluding anything is unfetchable. Without this a
# down node looks like every transaction being missing, and the script would cheerfully
# empty the whole queue.
TIP="$(rpc getblockcount '[]' | grep -oE '"result":[0-9]+' | cut -d: -f2)"
[ -n "$TIP" ] || { echo "ABORT: zebra is not answering getblockcount. Fix the node first; an unreachable node is not proof a transaction is gone." >&2; exit 1; }
echo "zebra tip: $TIP"

QUEUED="$(sq 'select hex(txid) from tx_retrieval_queue;' | tr -d '\r')"
[ -n "$QUEUED" ] || { echo "nothing to do: tx_retrieval_queue is empty"; exit 0; }
echo "queued retrieval requests: $(echo "$QUEUED" | wc -l | tr -d ' ')"

UNFETCHABLE=()
for HX in $QUEUED; do
  LOWER="$(echo "$HX" | tr 'A-F' 'a-f')"
  if rpc getrawtransaction "[\"$LOWER\"]" | grep -q '"error":null'; then
    echo "  ${HX:0:12}… zebra has it, leaving alone"
  else
    echo "  ${HX:0:12}… UNFETCHABLE"
    UNFETCHABLE+=("$HX")
  fi
done

[ "${#UNFETCHABLE[@]}" -gt 0 ] || { echo "nothing to do: every queued transaction is still fetchable"; exit 0; }

if [ "$DRY_RUN" = "1" ]; then
  echo; echo "--dry-run: would delete ${#UNFETCHABLE[@]} row(s), nothing changed"
  exit 0
fi

BAK="/var/lib/docker/volumes/${VOLUME}/_data/wallet.db.bak-queuefix-$(date +%s)"
cp -f "/var/lib/docker/volumes/${VOLUME}/_data/wallet.db" "$BAK"
echo "backup: $BAK"

# Every table's count before and after, so an unexpected cascade is surfaced rather than
# hidden behind "the queue got shorter". Money tables MUST NOT move.
COUNTS='select name || "=" || (select count(*) from pragma_table_info(name)) from sqlite_master where type="table" and name not like "sqlite_%"'
BEFORE="$(sq 'select "queue=" || (select count(*) from tx_retrieval_queue) || " transactions=" || (select count(*) from transactions) || " ironwood_notes=" || (select count(*) from ironwood_received_notes) || " sent_notes=" || (select count(*) from sent_notes) || " transparent_outputs=" || (select count(*) from transparent_received_outputs);')"
echo "before: $BEFORE"

LIST="$(printf "'%s'," "${UNFETCHABLE[@]}")"; LIST="${LIST%,}"
sq "pragma foreign_keys=ON; delete from tx_retrieval_queue where hex(txid) in ($LIST);"

AFTER="$(sq 'select "queue=" || (select count(*) from tx_retrieval_queue) || " transactions=" || (select count(*) from transactions) || " ironwood_notes=" || (select count(*) from ironwood_received_notes) || " sent_notes=" || (select count(*) from sent_notes) || " transparent_outputs=" || (select count(*) from transparent_received_outputs);')"
echo "after:  $AFTER"
echo "integrity: $(sq 'pragma integrity_check;')"
FK="$(sq 'pragma foreign_key_check;')"
echo "foreign_key_check: ${FK:-clean}"
echo
echo "done. start zallet:  docker start $ZALLET_CONTAINER"
echo "then watch:          docker logs -f --tail 20 $ZALLET_CONTAINER"
echo
echo "Expect ONE more crash on the boot that was already in flight, then recovery -"
echo "check the NEWEST log and 'docker ps', not the first crash in the scrollback."
