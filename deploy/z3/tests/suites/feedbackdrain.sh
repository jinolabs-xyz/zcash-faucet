# feedback-drain.sh: the box half of item 3. The app writes a row and answers 202; this sends it.
#
# THE STUB ANSWERS PER QUERY, deliberately. zalletclean's stub answered EVERY sqlite query with one
# token, and that single fact hid a report that had never once been produced and a count that was
# wrong on every run. A fixture that is easier to type than the thing it stands for stops being
# evidence about it.
# shellcheck shell=bash

fd_env() {
  mk_scratch "${TMPDIR:-/tmp}/feedbackdrain.XXXXXX"
  mkdir -p "$T/bin" "$T/vol" "$T/state"
  : > "$T/sql.log"; : > "$T/alert.argv"
  printf 'x' > "$T/vol/faucet.db"          # only its EXISTENCE is checked
  export FEEDBACK_DB_DIR="$T/vol" FEEDBACK_STATE_DIR="$T/state" FEEDBACK_ALERT="$T/bin/alert.sh"
  export STUB_SQL_LOG="$T/sql.log"
  unset FEEDBACK_DRAIN_MAX FEEDBACK_MAX_ATTEMPTS FEEDBACK_STALE_SECS STUB_ALERT_FAIL
  export STUB_IDS="1" STUB_BODY="hello" STUB_REPLY="" STUB_REMAINING=0 STUB_POISON=0 STUB_OLDEST=0 STUB_ANON=0

  cat > "$T/bin/docker" <<'D'
#!/usr/bin/env bash
# The drainer's sq() is: docker run --rm -v DIR:/d alpine:3 sh -c '...sqlite3 /d/faucet.db "$1"' _ SQL
# so the SQL is the LAST argument. Answered by shape, and every query is logged.
sql="${!#}"
printf '%s\n' "$sql" >> "${STUB_SQL_LOG:?}"
case "$sql" in
  *"select id from feedback"*)                 printf '%s\n' ${STUB_IDS:-} ;;
  *"select body from feedback"*)               printf '%s' "${STUB_BODY:-}" ;;
  *"coalesce(reply_to"*)                       printf '%s' "${STUB_REPLY:-}" ;;
  *"attempts >="*)                             printf '%s' "${STUB_POISON:-0}" ;;
  *"attempts <"*)                              printf '%s' "${STUB_REMAINING:-0}" ;;
  *"min(created_at)"*)                         printf '%s' "${STUB_OLDEST:-0}" ;;
  *"ip_hash = 'anon'"*)                        printf '%s' "${STUB_ANON:-0}" ;;
  *) : ;;
esac
exit 0
D
  chmod +x "$T/bin/docker"

  # alert.sh double: records its ARGV, one argument per line, so a body that was split or evaluated
  # is visible rather than inferred.
  cat > "$T/bin/alert.sh" <<'A'
#!/usr/bin/env bash
for a in "$@"; do printf '%s\n' "$a" >> "${ALERT_ARGV:?}"; done
printf -- '--END--\n' >> "$ALERT_ARGV"
[ "${STUB_ALERT_FAIL:-0}" = "1" ] && exit 1
exit 0
A
  chmod +x "$T/bin/alert.sh"
  export ALERT_ARGV="$T/alert.argv"
  export PATH="$T/bin:$PATH"
}

fd_run() { set +e; OUT="$(bash "$DRAIN" 2>&1)"; RC=$?; set -e; printf '%s\n' "$OUT" > "$T/last.out"; }

echo "== feedback drain: an unsent row is sent and then marked, in that order"
fd_env
export STUB_IDS="7" STUB_BODY="the faucet is great" STUB_REMAINING=0
fd_run
check "it exits clean" "[ $RC -eq 0 ]"
check "it asked for UNSENT rows only, oldest first, and capped the batch" \
  "grep -q 'sent_at is null' '$T/sql.log' && grep -q 'order by created_at' '$T/sql.log' && grep -q 'limit 20' '$T/sql.log'"
check "and it skips rows that have already failed too often, rather than retrying the head for ever" \
  "grep -q 'attempts < 5' '$T/sql.log'"
check "the body reached the sender" "grep -q 'the faucet is great' '$T/alert.argv'"
check "and the row was marked sent" "grep -qE 'update feedback set sent_at = [0-9]+ where id = 7' '$T/sql.log'"
check "and it says what it did" "grep -q 'sent 1, failed 0' '$T/last.out'"

echo "== feedback drain: A STRANGER'S TEXT IS AN ARGUMENT, NEVER A COMMAND"
# THE ROW THIS SUITE EXISTS FOR. body and reply_to are whatever someone typed into a public form.
# If either ever reached a shell as anything but a single quoted argument, this is where it shows.
fd_env
export STUB_IDS="9" STUB_BODY='$(touch '"$T"'/PWNED); `touch '"$T"'/PWNED2`; "quotes" and a $HOME'
fd_run
check "nothing executed: the command substitution did not run" "[ ! -e '$T/PWNED' ]"
check "and neither did the backticks" "[ ! -e '$T/PWNED2' ]"
check "the text arrived INTACT, not expanded, not split" \
  "grep -qF '\$(touch' '$T/alert.argv' && grep -qF '\"quotes\"' '$T/alert.argv' && grep -qF '\$HOME' '$T/alert.argv'"
check "and it was ONE argument, not several" \
  "[ \"\$(grep -c -- '--END--' '$T/alert.argv')\" = 1 ] && [ \"\$(grep -vc -- '--END--' '$T/alert.argv')\" = 2 ]"

echo "== feedback drain: a send that FAILS counts an attempt and does NOT claim delivery"
fd_env
export STUB_IDS="3" STUB_ALERT_FAIL=1
fd_run
check "the row is not marked sent" "! grep -q 'set sent_at' '$T/sql.log'"
check "the attempt is counted, so a poison row eventually stops blocking the queue" \
  "grep -q 'set attempts = attempts + 1' '$T/sql.log'"
check "and the run says so rather than reporting a clean drain" "grep -q 'sent 0, failed 1' '$T/last.out'"

echo "== feedback drain: the ceiling DROPS with a count, it never truncates silently"
fd_env
export STUB_IDS="1 2" STUB_REMAINING=37
fd_run
check "what is left is counted and said" "grep -q '37 more not sent' '$T/last.out'"

echo "== feedback drain: rows past the attempt limit are reported, not hidden"
fd_env
export STUB_IDS="" STUB_POISON=4
fd_run
check "the stuck ones are named in the same line" "grep -q '4 past the attempt limit' '$T/last.out'"

echo "== feedback drain: undelivered mail older than the threshold PAGES, once"
# THE ALARM THAT MAKES THE 30-DAY RETENTION SAFE. The table deletes undelivered rows at 30 days;
# this is what guarantees the delete can only remove something somebody already declined to act on.
fd_env
export STUB_IDS="" STUB_OLDEST=$(( $(date -u +%s) - 400000 ))
fd_run
check "it pages" "grep -q 'NEEDS YOU: feedback is not being delivered' '$T/alert.argv'"
check "and it says how old, and that the table will delete it" \
  "grep -q 'the table deletes at 30d' '$T/alert.argv'"
fd_run
check "a second run does not page again, because it is a STATE" \
  "[ \"\$(grep -c 'NEEDS YOU: feedback' '$T/alert.argv')\" = 1 ]"

echo "== feedback drain: and it says when delivery recovers, so a second episode can page"
fd_env
export STUB_IDS="" STUB_OLDEST=$(( $(date -u +%s) - 400000 ))
fd_run
export STUB_OLDEST=0
fd_run
check "the recovery is reported" "grep -q 'FIXED: feedback is being delivered again' '$T/alert.argv'"

echo "== feedback drain: a caller with no fingerprint is COUNTED, because that number should be zero"
# If the proxy ever stops setting the forwarded header every caller shares one rate-limit bucket and
# the form dies silently as 429s. Nothing else on the box counts this.
fd_env
export STUB_IDS="" STUB_ANON=12
fd_run
check "it says how many rows carry no fingerprint" "grep -q '12 feedback row(s) carry no caller fingerprint' '$T/last.out'"
check "and says what a climbing number would mean" "grep -q 'shares one rate-limit bucket' '$T/last.out'"

echo "== feedback drain: no ledger is not an error"
fd_env
rm -f "$T/vol/faucet.db"
fd_run
check "a box that has never served a drip drains nothing and exits clean" \
  "[ $RC -eq 0 ] && grep -q 'nothing to drain' '$T/last.out'"
check "and it sent nothing" "[ ! -s '$T/alert.argv' ]"
