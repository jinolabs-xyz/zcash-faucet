#!/usr/bin/env bash
# Turns the faucet's own endpoints into Prometheus metrics.
#
# The app already answers the questions worth alerting on (/api/ready says
# whether a drip can be served and why not, /api/status carries balance,
# queue depth and sync progress), but only as JSON to whoever asks. This
# writes them as a Prometheus textfile so they can be graphed and alerted on
# without adding a metrics dependency to the app or another daemon to the box.
#
# Output goes to $METRICS_FILE, written atomically (temp file then rename) so
# a scrape never reads a half-written file. Point node_exporter's
# --collector.textfile.directory at that directory, or just read the file:
#
#   watch -n5 cat /var/lib/node_exporter/textfile/faucet.prom
#
# Run it under faucet-metrics.timer. Logs go to stdout for journald.
#
# Deliberately not exposed over HTTP. Scraping is a pull from inside the box
# (node_exporter, or a sidecar), so nothing new gets published to the
# internet, and the wallet balance stays off a public endpoint that does not
# already carry it.
set -uo pipefail

# THE PROBE CONFIG IS THE WATCHDOG'S, unless this script is told otherwise. Both ask the
# same faucet the same questions, but this one read only METRICS_* names out of
# /etc/faucet/metrics.env, a file nobody creates, so it fell back to defaults that are
# wrong on the real box: the app is behind caddy and publishes no port, and the container
# is not called faucet-web. Measured on production 2026-09-09, months after install:
# `faucet_up 0` and `faucet_web_container_up 0` on a faucet that was serving, with every
# app gauge (ready, balance, queue, node height) absent (risk register #19). The watchdog
# has the right values in /etc/faucet/watchdog.env and has had them all along.
#
# Resolution order, per setting: METRICS_* (this script's own, from metrics.env or the
# environment), then the watchdog's WATCHDOG_* from its env file, then the default.
# Sourced in a clean subshell, the way box-report.sh resolves the alert config, so a
# comment, quotes and shell expansion all behave. NOT the same parser as systemd's
# EnvironmentFile=: that one does not accept an `export` prefix and this does, so a file
# written for one reader can be read differently by the other. Sourcing is the more
# permissive of the two, which is the safe direction here (nothing this reads is a
# credential, and a value systemd would skip still reaches the right variable).
WATCHDOG_ENV="${METRICS_WATCHDOG_ENV:-/etc/faucet/watchdog.env}"
wd_value() { # $1 = variable name in watchdog.env
  [ -f "$WATCHDOG_ENV" ] || return 0
  env -i HOME=/ PATH=/usr/bin:/bin bash -c '
    . "$1" >/dev/null 2>&1 || true
    printf "%s" "${!2-}"' _ "$WATCHDOG_ENV" "$1" 2>/dev/null || true
}

FAUCET_URL="${METRICS_FAUCET_URL:-$(wd_value WATCHDOG_FAUCET_URL)}"
if [ -n "$FAUCET_URL" ]; then
  URL_FROM="${METRICS_FAUCET_URL:+METRICS_FAUCET_URL}"; URL_FROM="${URL_FROM:-$WATCHDOG_ENV}"
else
  # The half of the config with no container to warn about. An unreadable watchdog.env
  # (a hardened unit, a syntax error above the URL line) silently reverts to a default
  # that answers nothing on this box, which is the failure being fixed, arriving again.
  FAUCET_URL="http://127.0.0.1:3000"; URL_FROM="the built-in default, because neither METRICS_FAUCET_URL nor $WATCHDOG_ENV supplied one"
fi
METRICS_FILE="${METRICS_FILE:-/var/lib/node_exporter/textfile/faucet.prom}"
CURL_TIMEOUT="${METRICS_CURL_TIMEOUT:-8}"
# Container names are matched by substring, same convention as watchdog.sh.
ZEBRA_MATCH="${METRICS_ZEBRA_MATCH:-$(wd_value WATCHDOG_ZEBRA_MATCH)}"
ZEBRA_MATCH="${ZEBRA_MATCH:-zebra}"
ZALLET_MATCH="${METRICS_ZALLET_MATCH:-$(wd_value WATCHDOG_ZALLET_MATCH)}"
ZALLET_MATCH="${ZALLET_MATCH:-zallet}"
FAUCET_MATCH="${METRICS_FAUCET_MATCH:-$(wd_value WATCHDOG_FAUCET_MATCH)}"
FAUCET_MATCH="${FAUCET_MATCH:-faucet-web}"
# Filesystems worth watching, and the floor under which the box is in trouble.
METRICS_DISK_PATHS="${METRICS_DISK_PATHS:-/ /var/lib/zsnap /var/lib/faucet-backups}"
METRICS_DISK_FLOOR_PCT="${METRICS_DISK_FLOOR_PCT:-10}"

log() { echo "$(date -u +%FT%TZ) faucet-metrics: $*"; }
# Shared sender, so a low-disk warning pages the same channel as everything else.
ALERT_SH="${METRICS_ALERT_SH:-$(dirname "$0")/alert.sh}"

# Pulls a numeric or boolean field out of a JSON blob without needing jq,
# which is not installed on a stock box. Prints nothing when the field is
# absent or null, and the caller decides what that means.
jfield() { # $1 json, $2 key
  printf '%s' "$1" \
    | grep -o "\"$2\":[[:space:]]*\(true\|false\|null\|-\?[0-9.]\+\([eE][-+]\?[0-9]\+\)\?\)" \
    | head -n1 | sed 's/.*:[[:space:]]*//'
}
# Pulls a nested object out by key, e.g. the "node":{...} blob, so its fields
# can be read without confusing them with same-named top-level keys ("ready"
# exists at both levels and means different things).
# Returns the body from just inside the object's opening brace to the END of the input, so
# jfield on it finds the object's OWN fields first. The previous regex, `{[^{}]*}`, could
# not match an object containing another object, and `node` has carried nested `shield`
# and `chain` objects since the freshness gate landed: faucet_node_ready,
# faucet_node_sync_percent and faucet_node_height had silently vanished from the real
# metrics file while the fixture, which had no nesting, kept the suite green. Bash
# expansion rather than sed: `#*` strips the SHORTEST prefix, so it is the first `"node":`
# in the body, not the last.
jobject() { # $1 json, $2 key
  local rest="${1#*\"$2\":}"
  [ "$rest" != "$1" ] || return 0
  # The value must BE an object: for `"node":null` the first brace after the key belongs
  # to the NEXT object, and with cTAZ enabled that object also carries height and
  # syncPercent, so the node gauges reported the feature-net's numbers. Review, 2026-09-09.
  rest="${rest#"${rest%%[![:space:]]*}"}"
  case "$rest" in \{*) ;; *) return 0 ;; esac
  # And ONLY that object: cut at the brace that closes it, counting nesting, so a key the
  # object lacks is answered by nothing rather than by the next object's field of the
  # same name. Strings are skipped so a brace inside a reason text does not count.
  printf '%s' "$rest" | tr '\n' ' ' | awk '
    BEGIN { depth = 0; instr = 0; esc = 0; out = "" }
    {
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (instr) { if (esc) esc = 0; else if (c == "\\") esc = 1; else if (c == "\"") instr = 0 }
        else if (c == "\"") instr = 1
        else if (c == "{") depth++
        else if (c == "}") { depth--; if (depth == 0) { printf "%s", substr($0, 2, i - 2); exit } }
      }
      printf "%s", substr($0, 2); exit
    }'
}
# Booleans become 1/0 so Prometheus can graph them; anything else drops out.
#
# AND THE NUMBER HAS TO BE A NUMBER. The label side is guarded hard (label_escape,
# label_is_utf8) because one bad label makes node_exporter reject the WHOLE file - and the
# value side reaches the same outcome. `jfield`'s number class is a character set, not a
# grammar, so "balanceTaz":1.2.3 came through as `faucet_balance_taz 1.2.3`: measured,
# zero faucet_* series exported and node_textfile_scrape_error 1. A value that is not a
# float is dropped, which loses one gauge instead of all of them.
as_gauge() {
  case "$1" in
    true) echo 1 ;;
    false) echo 0 ;;
    null|"") echo "" ;;
    *)
      case "$1" in
        *[!0-9.eE+-]*|"") echo "" ;;
        *)
          # The shape AND the magnitude: 1e400 matches the shape and is not a float64, and
          # promtool refuses it, which takes the whole file with it. awk's own conversion
          # is the cheapest oracle for "a number this consumer can hold".
          if printf '%s' "$1" | grep -qE '^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$' \
             && awk -v v="$1" 'BEGIN { n = v + 0; s = sprintf("%g", n); exit (s ~ /inf|nan/) ? 1 : 0 }'; then
            echo "$1"
          else
            echo ""
          fi ;;
      esac ;;
  esac
}
# ONE string, used by both branches. It was written out twice and only the `1` branch was
# widened, so the wording an operator reads at the moment the gauge goes to 0 - the only
# moment anyone reads it - still blamed the app for what may be DNS, TLS or the proxy.
UP_HELP="1 when the app itself answered (HTTP 200 or 503) at the probe URL. That URL is the watchdog's, usually the PUBLIC origin, so 0 covers DNS, TLS and the proxy as well as the app; a 502 from the proxy is 0, not 1."
# HELP AND TYPE TAKE THE BARE METRIC NAME, and appear once per family. This used to
# interpolate whatever it was handed, so the disk gauges produced
# `# HELP faucet_disk_free_bytes{path="/"} Free bytes...`, which is not the exposition
# format. node_exporter's textfile collector rejects the WHOLE FILE on it: measured
# against prom/node-exporter, zero faucet_* series exported and
# node_textfile_scrape_error 1, with `invalid metric name in comment` in its log. `/`
# always exists, so the disk block always ran, so the file was always rejected, and every
# gauge here - up, balance, the send gate - reached Prometheus as nothing at all. A
# repeated HELP for one name is a parse error too, which is why the header is hoisted out
# of the loop rather than emitted per path.
emit_help() { # $1 bare name, $2 help, $3 type
  printf '# HELP %s %s\n# TYPE %s %s\n' "$1" "$2" "$1" "$3"
}
emit_sample() { # $1 name with any labels, $2 value (skipped when empty)
  [ -n "$2" ] || return 0
  printf '%s %s\n' "$1" "$2"
}
# A label VALUE has its own escaping, and a path is operator-supplied. An unescaped `"`
# ends the value early and a `\` starts an escape sequence, either of which makes
# node_exporter reject the whole file - the same failure this file was just fixed for,
# arriving through the one field a human types.
label_escape() { # $1 raw label value
  local v="$1"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  printf '%s' "$v"
}
# A label value must also be valid UTF-8, and escaping cannot make it so: a directory name
# is bytes, not text, and a stray one (a mojibake paste into metrics.env, a filesystem
# restored from a different locale) makes node_exporter refuse the WHOLE file while this
# script logs "wrote N metrics". Refusing the one path is the only honest answer.
label_is_utf8() { # $1 raw label value
  if ! command -v iconv >/dev/null 2>&1; then
    # Cannot check, and saying so beats a silent pass: the file this would have caught is
    # one the scraper refuses whole while this script logs "wrote N metrics".
    warn_throttled "no-iconv" "WARNING: no iconv here, so a path that is not valid UTF-8 cannot be caught and would make the scraper reject the whole file"
    return 0
  fi
  printf '%s' "$1" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1
}
emit() { # $1 name, $2 help, $3 type, $4 value: one family, one sample, no labels
  [ -n "$4" ] || return 0
  emit_help "$1" "$2" "$3"
  emit_sample "$1" "$4"
}
# Sets CONTAINER_NAME and CONTAINER_LOOKUP: found | none | docker-error. `-a` on purpose:
# a container that EXISTS but is stopped must report down, not "no such name".
container_lookup() { # $1 match
  local out rc
  out="$(docker ps -a --filter "name=$1" --format '{{.Names}}' 2>/dev/null)"; rc=$?
  CONTAINER_NAME="$(printf '%s' "$out" | head -n1)"
  if [ "$rc" -ne 0 ]; then CONTAINER_LOOKUP="docker-error"
  elif [ -z "$CONTAINER_NAME" ]; then CONTAINER_LOOKUP="none"
  else CONTAINER_LOOKUP="found"; fi
}

# N1: at most one warning per cause per hour. This runs every 30 seconds, and a mismatch
# nobody has got round to would otherwise be 8640 identical journal lines a day, which is
# how a real line stops being read.
WARN_STATE_DIR="${METRICS_WARN_STATE_DIR:-/var/lib/faucet}"
WARN_EVERY_RAW="${METRICS_WARN_EVERY_SECONDS:-3600}"
# Validated once, the way alert.sh validates its cooldown and for the same reason: "1h"
# reads as "not > 0", turns the throttle off in silence, and adds a shell error per cause
# per run on top.
case "$WARN_EVERY_RAW" in
  ''|*[!0-9]*) WARN_EVERY=3600
    log "WARNING: METRICS_WARN_EVERY_SECONDS='$WARN_EVERY_RAW' is not a whole number of seconds; using 3600" >&2 ;;
  *) # Leading zeros first, or "000000010" reads as nine digits and is capped.
     WARN_EVERY="$(printf '%s' "$WARN_EVERY_RAW" | sed 's/^0*//')"; WARN_EVERY="${WARN_EVERY:-0}"
     if [ "${#WARN_EVERY}" -gt 7 ] || [ "$WARN_EVERY" -gt 86400 ]; then
       WARN_EVERY=3600
       log "WARNING: METRICS_WARN_EVERY_SECONDS=$WARN_EVERY_RAW is more than a day; using 3600" >&2
     fi ;;
esac
# Validated the way METRICS_WARN_EVERY_SECONDS is, and for a worse reason: this script is
# the box's only disk alerting (watchdog.sh has no disk check), so "10%" or "ten" silently
# turned it off while printing two `integer expression expected` errors per path per run.
FLOOR_RAW="$METRICS_DISK_FLOOR_PCT"
case "$METRICS_DISK_FLOOR_PCT" in
  ''|*[!0-9]*)
    log "WARNING: METRICS_DISK_FLOOR_PCT='$METRICS_DISK_FLOOR_PCT' is not a whole percent; using 10" >&2
    METRICS_DISK_FLOOR_PCT=10 ;;
  *)
    METRICS_DISK_FLOOR_PCT="$(printf '%s' "$METRICS_DISK_FLOOR_PCT" | sed 's/^0*//')"
    METRICS_DISK_FLOOR_PCT="${METRICS_DISK_FLOOR_PCT:-0}"
    # No upper bound at 100: a floor above it is how you force the alert on purpose, and
    # the suite does exactly that. Only a value too long to be a percent is refused.
    # 0 is a legitimate "never alert", and it is also what a typo looks like. This script
    # is the box's only disk alerting, so it says so rather than going quiet.
    [ "$METRICS_DISK_FLOOR_PCT" = 0 ] && log "note: METRICS_DISK_FLOOR_PCT=$FLOOR_RAW, so no disk floor alert will ever fire" >&2
    if [ "${#METRICS_DISK_FLOOR_PCT}" -gt 4 ]; then
      log "WARNING: METRICS_DISK_FLOOR_PCT=$FLOOR_RAW is not a percent; using 10" >&2
      METRICS_DISK_FLOOR_PCT=10
    fi ;;
esac

# A FILENAME-SAFE, COLLISION-RESISTANT KEY for a path. `tr -c 'A-Za-z0-9' '-'` alone
# mapped /tmp/a-b and /tmp/a.b to the same key, so only the first was ever reported, and a
# 300-character path made the state filename exceed NAME_MAX - which turned the throttle
# off and blamed the state directory, which was fine.
path_key() { # $1 path
  local safe hash
  safe="$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"
  hash="$(printf '%s' "$1" | cksum | cut -d' ' -f1)"
  printf '%s-%s' "$(printf '%s' "$safe" | tail -c 48)" "$hash"
}

warn_throttled() { # $1 = cause key, $2... = message
  local key="$1"; shift
  local f="$WARN_STATE_DIR/.metrics-warn-$key" now last age
  now="$(date -u +%s)"
  if mkdir -p "$WARN_STATE_DIR" 2>/dev/null && [ -f "$f" ]; then
    last="$(cat "$f" 2>/dev/null || echo 0)"
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    age=$((now - last))
    # A stamp in the FUTURE (a clock step back, or a restored filesystem) would otherwise
    # be "not old enough" until wall-clock caught up, silencing the cause for as long as
    # the step. Under-warning is the failure this file exists to fix, so it releases.
    [ "$age" -ge 0 ] && [ "$age" -lt "$WARN_EVERY" ] && return 0
  fi
  # The redirection is what fails on a read-only state dir, and 2>/dev/null does not cover
  # a failing redirection, so the shell printed its own error per cause per run: noisier
  # than having no throttle at all. Test it first and say once what that means.
  if ! ( : > "$f" ) 2>/dev/null; then
    [ -n "${WARN_DEGRADED:-}" ] || log "throttle OFF: cannot write $WARN_STATE_DIR, so repeats of these warnings will all be printed" >&2
    WARN_DEGRADED=1
  else
    printf '%s' "$now" > "$f" 2>/dev/null || true
  fi
  log "$*" >&2
}

# Say what is being probed and where that came from. Without this the URL half of the
# config has no diagnosis at all: a wrong one just makes faucet_up 0, which is exactly
# what a down faucet looks like, and that is what hid the original bug for months.
log "probing $FAUCET_URL (from $URL_FROM); containers zebra=$ZEBRA_MATCH zallet=$ZALLET_MATCH faucet=$FAUCET_MATCH" >&2

mkdir -p "$(dirname "$METRICS_FILE")"
tmp="$(mktemp "${METRICS_FILE}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

now="$(date -u +%s)"

# /api/ready is the one that decides whether anyone should be paged: 200 when
# a drip can be served, 503 with the most upstream reason when not.
# A 503 is a real answer, not a failure to reach the app, so the code is read rather than
# curl's exit status. 200 and 503 are the app's own answers; a 502 or 504 is the PROXY
# saying the app did not answer it, and its error page is a non-empty body that used to
# read as faucet_up 1 with every other gauge absent - a shape in which neither
# `faucet_up == 0` nor `faucet_ready == 0` can fire.
# -s alone: -S would re-enable the error message that the 2>/dev/null right after it
# throws away, so it never reached the journal. The exit status carries the diagnosis.
ready_raw="$(curl -s --max-time "$CURL_TIMEOUT" -w '\n%{http_code}' "$FAUCET_URL/api/ready" 2>/dev/null)"
ready_rc=$?
ready_code="${ready_raw##*$'\n'}"
ready_body="${ready_raw%$'\n'*}"
# THE STATUS AND THE CODE, not just the code. A server that sends 200 and half a body and
# then hangs past --max-time gives curl 28 with http_code 200, and `ready` and `canBuildTx`
# were parsed out of the fragment: faucet_up 1 and faucet_ready 1 on a truncated answer,
# which is a shape where neither alert rule can fire. watchdog.sh guards this the same way.
if [ "$ready_rc" -ne 0 ]; then
  log "the probe URL did not answer cleanly (curl exit $ready_rc, code ${ready_code:-none}): treating it as no answer" >&2
  ready_body=""
else
  case "$ready_code" in
    # 200 and 503 are the app's own answers. An EMPTY code means curl wrote none; a
    # literal 000 is its sentinel for "nothing came back", and it cannot reach here
    # because curl always exits non-zero with it and the status branch above catches it
    # first - it falls to the catch-all, which is honest enough for an unreachable case.
    200|503)
      if [ -z "$ready_body" ]; then
        log "the probe URL answered $ready_code with an EMPTY body, so there is nothing to read" >&2
      elif { case "$ready_body" in '{"ready":'*|'{ "ready":'*|'{"ready" :'*) false ;; *) true ;; esac; } \
           || [ -z "$(jfield "$ready_body" ts)" ]; then
        # THE BODY HAS TO BE /api/ready's, START AND END. A 200 alone is not the app:
        # caddy's maintenance page and a mis-routed vhost both answer 200 with HTML, and a
        # close-delimited truncation makes curl exit 0 with half a body.
        #
        # BOTH ENDS, and `ready` has to be the body's FIRST key rather than merely present
        # somewhere in it. jfield searches the whole string, so a foreign body carrying
        # `node.ready` satisfied a presence test and had its nested value read as top-level
        # readiness - measured, faucet_up 1 AND faucet_ready 1 out of someone else's API,
        # and adding `ts` did not close it because foreign bodies carry timestamps too.
        # `ready` first is what the route emits and what faucet_ready already depends on;
        # the repo suite pins that in route.ts so it cannot drift. `ts` is the LAST key, in
        # the 200 and the 503 alike, so a body that stops early loses it.
        log "the probe URL answered $ready_code but the body is not /api/ready's (needs \`ready\` and \`ts\`): treating it as no answer" >&2
        ready_body=""
      fi ;;
    "") log "the probe URL did not answer at all (no HTTP status)" >&2; ready_body="" ;;
    *) log "the probe URL answered $ready_code, which is not the app (200 or 503): treating it as no answer" >&2
       ready_body="" ;;
  esac
fi
status_body="$(curl -fs --max-time "$CURL_TIMEOUT" "$FAUCET_URL/api/status" 2>/dev/null)"
status_rc=$?
# /api/status always returns 200 when the app is up, so -f only discards proxy errors and
# 500s - where absent gauges are the right answer. But say so: five gauges vanishing with
# no journal line is the silence this whole branch exists to end.
if [ "$status_rc" -ne 0 ]; then
  log "GET /api/status did not answer cleanly (curl exit $status_rc), so its gauges are absent" >&2
  status_body=""
elif [ -n "$status_body" ] && { case "$status_body" in *'"network":'*|*'"network" :'*) false ;; *) true ;; esac; }; then
  # Same reasoning as /api/ready: a 200 that is not this app's body is not an answer, and
  # five gauges going missing with no journal line is the silence this branch is about.
  # A key-presence test, not jfield: `network` is a STRING and jfield only reads
  # booleans, null and numbers, so asking it would blank every status gauge on a
  # perfectly good body. WITH THE COLON, so the word has to be a key: without it a foreign
  # body carrying `"error":"network"` passed, and its queueDepth was written as ours.
  log "GET /api/status answered but the body is not the faucet's (no \`network\` field), so its gauges are absent" >&2
  status_body=""
fi

{
  if [ -n "$ready_body" ]; then
    emit faucet_up "$UP_HELP" gauge 1
    emit faucet_ready "1 when the faucet can serve a drip right now." gauge \
      "$(as_gauge "$(jfield "$ready_body" ready)")"
    emit faucet_node_ready "1 when the node reports itself synced." gauge \
      "$(as_gauge "$(jfield "$(jobject "$ready_body" node)" ready)")"
    # The send gate's verdict. A 200 with this at 0 is a faucet refusing every drip while
    # readiness stays green on purpose (a tip it cannot verify); whatever scrapes this file
    # must not believe faucet_ready alone. The key is unique in the body.
    emit faucet_can_build_tx "1 when the send gate would let a drip be built right now." gauge \
      "$(as_gauge "$(jfield "$ready_body" canBuildTx)")"
  else
    # Distinguish "the app said no" from "the app said nothing". Only the
    # second one means the web process itself is the problem.
    emit faucet_up "$UP_HELP" gauge 0
  fi

  if [ -n "$status_body" ]; then
    emit faucet_balance_taz "Spendable faucet balance in TAZ." gauge \
      "$(as_gauge "$(jfield "$status_body" balanceTaz)")"
    emit faucet_empty "1 when the faucet has nothing left to send." gauge \
      "$(as_gauge "$(jfield "$status_body" empty)")"
    emit faucet_queue_depth "Sends waiting in the serialized send queue." gauge \
      "$(as_gauge "$(jfield "$status_body" queueDepth)")"
    node_obj="$(jobject "$status_body" node)"
    emit faucet_node_sync_percent "Node sync progress, 0-100." gauge \
      "$(as_gauge "$(jfield "$node_obj" syncPercent)")"
    emit faucet_node_height "Block height the node has verified." gauge \
      "$(as_gauge "$(jfield "$node_obj" height)")"
  fi

  # A match that finds NOTHING reads exactly like a container that is down, and that is
  # how a wrong name stayed invisible for months. Say it once per run, naming the value,
  # so "0" that means "asked the wrong question" can be told from "0" that means down.
  # ONE `docker ps` PER MATCH, and the warning and the gauge read the same answer. They
  # used to be two separate lookups (the gauge's ran inside `$( )`, which cannot see this
  # loop's variables), so a container that stopped between them was warned about as
  # missing and gauged from a different snapshot. `{ } > "$tmp"` is not a subshell, so
  # what this loop sets is still here below.
  up_zebra=0; up_zallet=0; up_faucet=0
  for pair in "zebra:$ZEBRA_MATCH" "zallet:$ZALLET_MATCH" "faucet:$FAUCET_MATCH"; do
    container_lookup "${pair#*:}"
    # To the JOURNAL, not to stdout: this block's stdout IS the metrics file, and a
    # sentence in it makes the file unparseable for a scraper.
    case "$CONTAINER_LOOKUP" in
      none) warn_throttled "match-${pair%%:*}" "WARNING: no container matches ${pair%%:*}=\"${pair#*:}\", so its gauge reads 0 because nothing was found, not because it is down" ;;
      # A daemon that will not answer is a THIRD thing, and calling it "no match" sends an
      # operator to check a name that is fine.
      docker-error) warn_throttled "docker" "WARNING: docker did not answer, so every container gauge reads 0 without having been able to look" ;;
    esac
    up=0
    if [ "$CONTAINER_LOOKUP" = "found" ] \
       && [ "$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo missing)" = "running" ]; then
      up=1
    fi
    case "${pair%%:*}" in
      zebra)  up_zebra="$up" ;;
      zallet) up_zallet="$up" ;;
      faucet) up_faucet="$up" ;;
    esac
  done
  emit faucet_container_up "1 when the zebra container is running." gauge "$up_zebra"
  emit faucet_zallet_container_up "1 when the zallet container is running." gauge "$up_zallet"
  emit faucet_web_container_up "1 when the faucet web container is running." gauge "$up_faucet"
  # Disk. A full disk stops exports, backups and the chain at once, so this is
  # reported per filesystem rather than as one number.
  disk_head=0
  for path in $METRICS_DISK_PATHS; do
    if [ ! -d "$path" ]; then
      # To the JOURNAL, throttled, like the container-match warning: a typo here removes a
      # filesystem from the only disk alerting on this box, and reads exactly like a
      # filesystem that is fine. METRICS_DISK_PATHS is word-split, so a path containing a
      # space cannot be expressed and will show up here as its fragments.
      warn_throttled "disk-$(path_key "$path")" \
        "WARNING: METRICS_DISK_PATHS names \"$path\", which is not a directory, so it has no disk gauges and no floor alert"
      continue
    fi
    read -r fs_free fs_size <<EOF
$(df -Pk "$path" | awk 'NR==2 {print $4, $2}')
EOF
    [ -n "${fs_size:-}" ] && [ "$fs_size" -gt 0 ] || continue
    free_pct=$((fs_free * 100 / fs_size))
    # Lazily, so a run with no readable path emits no header for samples that never come.
    if [ "$disk_head" = 0 ]; then
      emit_help faucet_disk_free_bytes "Free bytes on the filesystem holding the labelled path." gauge
      emit_help faucet_disk_free_percent "Free percent on the filesystem holding the labelled path." gauge
      emit_help faucet_disk_below_floor "1 when free percent is under METRICS_DISK_FLOOR_PCT." gauge
      disk_head=1
    fi
    if ! label_is_utf8 "$path"; then
      warn_throttled "utf8-$(path_key "$path")" \
        "WARNING: a path in METRICS_DISK_PATHS is not valid UTF-8 (bytes: $(printf '%s' "$path" | od -An -tx1 | tr -d ' \n' | cut -c1-40)), so its gauges are skipped; a label like that makes the scraper reject the whole file"
      continue
    fi
    lbl="$(label_escape "$path")"
    emit_sample "faucet_disk_free_bytes{path=\"$lbl\"}" "$((fs_free * 1024))"
    emit_sample "faucet_disk_free_percent{path=\"$lbl\"}" "$free_pct"
    emit_sample "faucet_disk_below_floor{path=\"$lbl\"}" \
      "$([ "$free_pct" -lt "$METRICS_DISK_FLOOR_PCT" ] && echo 1 || echo 0)"
    if [ "$free_pct" -lt "$METRICS_DISK_FLOOR_PCT" ]; then
      log "DISK LOW: $path has ${free_pct}% free, floor is ${METRICS_DISK_FLOOR_PCT}%" >&2
      # 🚨 because nothing on the box can fix a full disk; alert.sh holds repeats of this
      # line to one an hour per path, so the 30-second timer cannot flood the channel.
      # Its output goes to stderr, deliberately: this block's stdout IS the metrics file,
      # and a "sent" or "HELD BACK" line in there is a line node_exporter rejects.
      [ -x "$ALERT_SH" ] && "$ALERT_SH" "🚨 NEEDS YOU: disk low: $path has ${free_pct}% free (floor ${METRICS_DISK_FLOOR_PCT}%), snapshots and backups will start failing" >&2
    fi
  done

  emit faucet_metrics_scrape_timestamp "Unix time this file was written." gauge "$now"
} > "$tmp"

# Rename is atomic on the same filesystem, so a scrape sees either the old
# file or the new one, never a partial write. The mode goes on BEFORE the rename: mktemp
# makes 0600, so chmod-after left a window, twice a minute, where a non-root scraper got
# EACCES on a file that had just been published.
chmod 644 "$tmp"
if ! mv "$tmp" "$METRICS_FILE"; then
  # Saying "wrote 0 metrics to <path>" about a file that does not exist is the kind of
  # journal line that sends someone to debug Prometheus. The stale
  # faucet_metrics_scrape_timestamp is the real backstop; this is about not lying.
  log "FAILED to publish $METRICS_FILE (is its directory writable?); the old file, if any, is untouched" >&2
  exit 1
fi
log "wrote $(grep -c '^faucet_' "$METRICS_FILE") metrics to $METRICS_FILE"
