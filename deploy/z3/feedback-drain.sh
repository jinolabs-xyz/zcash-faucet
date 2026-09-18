#!/usr/bin/env bash
# Drains the feedback table to the operator's Signal and marks what it sent.
#
# THE SEAM IS THE TABLE (SDE-App's call, #601 item 3). The app validates, rate-limits and INSERTs a
# row, then answers 202 knowing nothing about Signal. This runs on the box and is the only half that
# can reach outward, so the public container never acquires egress - we have had one outage from
# exactly that shape, when docker's publish rules bypassed ufw and the wallet RPC sat internet-
# reachable for nine days. The app's failure mode is a row that sits here, not a request that hangs.
#
# IT SENDS THROUGH alert.sh RATHER THAN POSTING ITSELF, and that is a safety decision, not laziness.
# alert.sh already owns the destination (box configuration, in no tracked file), the E.164 checks,
# and - the part that matters here - it encodes the message with `jq -Rs` or python's json.dumps and
# REFUSES to send when neither exists. This body is a stranger's text. It must never be built into
# JSON with printf and must never reach a shell as anything but a single quoted argument.
# `--now` is the right mode: DEDUP=0, never held, because two people saying the same thing are two
# messages and a cooldown would silently eat the second.
#
# Logs to stdout for journald. Run it from feedback-drain.timer.
set -uo pipefail

log() { echo "$(date -u +%FT%TZ) feedback-drain: $*"; }

FEEDBACK_VOLUME="${FEEDBACK_VOLUME:-zcash-faucet_faucet_data}"
ALERT="${FEEDBACK_ALERT:-/opt/faucet/alert.sh}"
# THE CEILING. This is the only unauthenticated public write path on the site that is not a claim,
# so assume it gets abused: one bad afternoon must not page the owner's phone several hundred times.
FEEDBACK_DRAIN_MAX="${FEEDBACK_DRAIN_MAX:-20}"
# A row that keeps failing is PASSED OVER, not retried for ever at the head of the queue. Without
# this, one message the sender cannot deliver blocks every message behind it.
FEEDBACK_MAX_ATTEMPTS="${FEEDBACK_MAX_ATTEMPTS:-5}"
# THE THING THAT MAKES THE 30-DAY RETENTION SAFE. The table deletes rows at 30 days whether or not
# they were delivered, which is right - keeping people's words indefinitely because our drainer
# broke is the worse failure. The risk is not the delete, it is REACHING it unnoticed. Days, not
# weeks, so the delete can only ever remove something somebody already declined to act on.
FEEDBACK_STALE_SECS="${FEEDBACK_STALE_SECS:-259200}"
STATE_DIR="${FEEDBACK_STATE_DIR:-/var/lib/faucet-feedback}"

vol_dir="${FEEDBACK_DB_DIR:-$(docker volume inspect -f '{{.Mountpoint}}' "$FEEDBACK_VOLUME" 2>/dev/null)}"
if [ -z "$vol_dir" ] || [ ! -f "$vol_dir/faucet.db" ]; then
  # Not an error: a box that has never served a drip has no ledger yet.
  log "no ledger at ${vol_dir:-<volume $FEEDBACK_VOLUME not found>}/faucet.db, nothing to drain"
  exit 0
fi

# sqlite3 through a container, exactly as the zallet repair tools do, so the box needs no sqlite
# installed and no version of ours to agree with.
sq() { docker run --rm -v "$vol_dir":/d alpine:3 sh -c 'apk add -q sqlite 2>/dev/null; sqlite3 /d/faucet.db "$1"' _ "$1"; }

now_s="$(date -u +%s)"

# IDS FIRST, BODIES ONE AT A TIME. A multi-row result carrying free text cannot be split safely -
# a body with a newline in it would become two rows and a body with the separator in it would become
# two columns. Ids are digits, so the list is safe to word-split, and each body is then fetched on
# its own and never parsed.
ids="$(sq "select id from feedback where sent_at is null and attempts < $FEEDBACK_MAX_ATTEMPTS order by created_at limit $FEEDBACK_DRAIN_MAX;" | tr -d '\r')"

sent=0; failed=0
for id in $ids; do
  case "$id" in ''|*[!0-9]*) continue ;; esac
  body="$(sq "select body from feedback where id = $id;")"
  reply="$(sq "select coalesce(reply_to,'') from feedback where id = $id;")"
  # ONE ARGUMENT, NEVER A COMMAND STRING. alert.sh does the JSON encoding; this must not try.
  if "$ALERT" --now "faucet feedback #$id${reply:+ (reply-to: $reply)}: $body" >/dev/null 2>&1; then
    sq "update feedback set sent_at = $now_s where id = $id;" >/dev/null 2>&1
    sent=$((sent + 1))
  else
    # The error is OURS, not the sender's: a transport that refused, not a message that was wrong.
    sq "update feedback set attempts = attempts + 1, last_error = 'send failed' where id = $id;" >/dev/null 2>&1
    failed=$((failed + 1))
  fi
done

# WHAT IS LEFT, COUNTED AND SAID. A cap that drops silently is a cap that loses messages without
# anyone learning they existed; a cap that says "N more not sent" is honest about the same drop.
remaining="$(sq "select count(*) from feedback where sent_at is null and attempts < $FEEDBACK_MAX_ATTEMPTS;" | tr -d '\r')"
case "$remaining" in ''|*[!0-9]*) remaining=0 ;; esac
poison="$(sq "select count(*) from feedback where sent_at is null and attempts >= $FEEDBACK_MAX_ATTEMPTS;" | tr -d '\r')"
case "$poison" in ''|*[!0-9]*) poison=0 ;; esac

log "sent $sent, failed $failed, $remaining more not sent, $poison past the attempt limit"

# THE STALENESS ALARM, which is what makes the 30-day delete a bounded risk rather than a silent
# loss. Said ONCE per episode: a timer that pages every run trains the reader to stop looking.
oldest="$(sq "select coalesce(min(created_at), 0) from feedback where sent_at is null;" | tr -d '\r')"
case "$oldest" in ''|*[!0-9]*) oldest=0 ;; esac
marker="$STATE_DIR/stale-warned"
if [ "$oldest" -gt 0 ] && [ "$((now_s - oldest))" -ge "$FEEDBACK_STALE_SECS" ]; then
  if [ ! -f "$marker" ]; then
    mkdir -p "$STATE_DIR" 2>/dev/null
    "$ALERT" --now "🚨 NEEDS YOU: feedback is not being delivered. The oldest undelivered message is $(( (now_s - oldest) / 86400 ))d old and the table deletes at 30d, so it will be lost rather than read. $remaining waiting, $poison past the attempt limit." >/dev/null 2>&1 \
      && : > "$marker"
  fi
elif [ -f "$marker" ]; then
  "$ALERT" --now "✅ FIXED: feedback is being delivered again ($remaining waiting)." >/dev/null 2>&1
  rm -f "$marker"
fi

# A NUMBER THAT SHOULD ALWAYS BE ZERO IS THE CHEAPEST ALARM THERE IS. The app's rate limiter falls
# back to a shared "anon" bucket when it cannot fingerprint a caller, which is correct - skipping the
# cap would be the free pass. But it is only SAFE while that is rare: if the proxy ever stops setting
# the forwarded header, every caller shares one bucket of five a day and the feature dies silently,
# as 429s that look exactly like abuse being repelled. Counted here because nothing else counts it.
anon="$(sq "select count(*) from feedback where ip_hash = 'anon';" | tr -d '\r')"
case "$anon" in ''|*[!0-9]*) anon=0 ;; esac
[ "$anon" -gt 0 ] && log "NOTE: $anon feedback row(s) carry no caller fingerprint. That should be near zero - if it is climbing, the proxy has stopped setting the forwarded header and every caller now shares one rate-limit bucket."

exit 0
