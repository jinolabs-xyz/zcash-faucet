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

# BOTH QUEUES, because cleaning only the first one is what this incident already proved
# insufficient. tx_retrieval_queue went 5 -> 0, zallet crash-looped anyway, and the
# remaining poison was in transparent_spend_search_queue: 12 rows asking "find the spend
# of output N of transaction T" where T expired unmined and so output N never existed on
# chain. That question can never be answered, and asking it kills the wallet.
UNFETCHABLE=()
echo "-- tx_retrieval_queue --"
QUEUED="$(sq 'select hex(txid) from tx_retrieval_queue;' | tr -d '\r')"
if [ -z "$QUEUED" ]; then
  echo "  empty"
else
  for HX in $QUEUED; do
    LOWER="$(echo "$HX" | tr 'A-F' 'a-f')"
    if rpc getrawtransaction "[\"$LOWER\"]" | grep -q '"error":null'; then
      echo "  ${HX:0:12}… zebra has it, leaving alone"
    else
      echo "  ${HX:0:12}… UNFETCHABLE"
      UNFETCHABLE+=("$HX")
    fi
  done
fi

# Candidates are only ever rows anchored to a NEVER-MINED transaction. A spend search
# against a mined transaction is a legitimate outstanding question and is left alone.
echo "-- transparent_spend_search_queue --"
SPEND_TXIDS="$(sq 'select distinct hex(t.txid) from transparent_spend_search_queue q join transactions t on t.id_tx = q.transaction_id where t.mined_height is null;' | tr -d '\r')"
SPEND_DEAD=()
if [ -z "$SPEND_TXIDS" ]; then
  echo "  no rows anchored to unmined transactions"
else
  for HX in $SPEND_TXIDS; do
    LOWER="$(echo "$HX" | tr 'A-F' 'a-f')"
    if rpc getrawtransaction "[\"$LOWER\"]" | grep -q '"error":null'; then
      echo "  ${HX:0:12}… unmined but zebra still has it, leaving alone"
    else
      echo "  ${HX:0:12}… UNFETCHABLE (its outputs never existed on chain)"
      SPEND_DEAD+=("$HX")
    fi
  done
fi

if [ "${#UNFETCHABLE[@]}" -eq 0 ] && [ "${#SPEND_DEAD[@]}" -eq 0 ]; then
  echo "nothing to do: every queued request is still answerable"
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  echo; echo "--dry-run: would drop ${#UNFETCHABLE[@]} retrieval row(s) and the spend-search rows for ${#SPEND_DEAD[@]} dead transaction(s), nothing changed"
  exit 0
fi

BAK="/var/lib/docker/volumes/${VOLUME}/_data/wallet.db.bak-queuefix-$(date +%s)"
cp -f "/var/lib/docker/volumes/${VOLUME}/_data/wallet.db" "$BAK"
echo "backup: $BAK"

# Every money table's count before and after, so an unexpected cascade is surfaced rather
# than hidden behind "the queue got shorter". Only the queue may move.
#
# NO STRING LITERALS IN THE SQL, deliberately. The SQL crosses a docker sh -c boundary,
# so a "label" inside it arrives at sqlite as an identifier and dies with
# `no such column: "queue="`. Bare counts survive any amount of requoting; the labels are
# added by bash, on this side of the boundary.
COUNTS_Q='select (select count(*) from tx_retrieval_queue), (select count(*) from transparent_spend_search_queue), (select count(*) from transactions), (select count(*) from ironwood_received_notes), (select count(*) from sent_notes), (select count(*) from transparent_received_outputs);'
label() { echo "retrieval_queue=$1 spend_queue=$2 transactions=$3 ironwood_notes=$4 sent_notes=$5 transparent_outputs=$6"; }

BEFORE="$(sq "$COUNTS_Q" | tr '|' ' ')"
echo "before: $(label $BEFORE)"

if [ "${#UNFETCHABLE[@]}" -gt 0 ]; then
  LIST="$(printf "'%s'," "${UNFETCHABLE[@]}")"; LIST="${LIST%,}"
  sq "pragma foreign_keys=ON; delete from tx_retrieval_queue where hex(txid) in ($LIST);"
fi
if [ "${#SPEND_DEAD[@]}" -gt 0 ]; then
  SLIST="$(printf "'%s'," "${SPEND_DEAD[@]}")"; SLIST="${SLIST%,}"
  # Deletes only the QUEUE rows. The transactions row it points at is left exactly as it
  # is: it carries notes and sends, and this script does not touch money.
  sq "pragma foreign_keys=ON; delete from transparent_spend_search_queue where transaction_id in (select id_tx from transactions where hex(txid) in ($SLIST));"
fi

AFTER="$(sq "$COUNTS_Q" | tr '|' ' ')"
echo "after:  $(label $AFTER)"
echo "integrity: $(sq 'pragma integrity_check;')"
FK="$(sq 'pragma foreign_key_check;')"
echo "foreign_key_check: ${FK:-clean}"
echo
echo "done. start zallet:  docker start $ZALLET_CONTAINER"
echo "then watch:          docker logs -f --tail 20 $ZALLET_CONTAINER"
echo
echo "Expect ONE more crash on the boot that was already in flight, then recovery -"
echo "check the NEWEST log and 'docker ps', not the first crash in the scrollback."
