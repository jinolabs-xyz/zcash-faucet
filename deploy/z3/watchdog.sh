#!/usr/bin/env bash
# Stack watchdog for the z3 shielded faucet. Its whole job is that no single
# failure leaves the faucet dark and needing a human on SSH. It does four things
# on a loop and nothing clever:
#
#   1. Reboot survival. Force restart=unless-stopped on every target container,
#      so a box reboot brings the whole stack back with no intervention.
#   2. Dead-container recovery. If a target container has exited or died, start
#      it again. This is the real fix for the wallet fault we kept hitting:
#      zallet exits when zebra closes the mempool stream, and this brings it
#      straight back instead of leaving drips paused.
#   3. Hung web-app recovery. If faucet-web is "running" but /api/health stops
#      answering, restart just that container.
#   4. Honest alerting. If the faucet is not READY (cannot serve a drip) for
#      longer than the grace window, POST to WATCHDOG_ALERT_URL once. It does
#      NOT restart anything for un-readiness alone, because a first sync or a
#      background refill is un-ready on purpose and restarting would only slow
#      it down.
#
# Everything is env-configurable so it survives the container-naming drift
# between the manual faucet-web and the compose overlay. Logs go to stdout so
# journald keeps them. Run it under the systemd unit next to this file.
set -uo pipefail

INTERVAL="${WATCHDOG_INTERVAL:-30}"                 # seconds between sweeps
FAUCET_URL="${WATCHDOG_FAUCET_URL:-http://127.0.0.1:3000}"
FAUCET_FAIL_LIMIT="${WATCHDOG_FAUCET_FAIL_LIMIT:-3}" # consecutive liveness misses before restart
READY_GRACE_SECS="${WATCHDOG_READY_GRACE_SECS:-1800}" # 30 min un-ready before we page
ALERT_URL="${WATCHDOG_ALERT_URL:-}"                 # optional webhook for alerts
ALERT_FORMAT="${WATCHDOG_ALERT_FORMAT:-slack}"      # slack (default) or discord

# Crash-loop escalation. A container that needs starting again and again is not
# being recovered, it is looping, and the old code could not tell the difference:
# it announced "recovered" on every attempt, so 812 consecutive failures over 16
# hours looked exactly like 812 successful self-heals and nobody was ever paged.
# Counts live on disk so a watchdog restart does not reset the evidence.
FLAP_ESCALATE="${WATCHDOG_FLAP_ESCALATE:-3}"        # consecutive attempts before we page
FLAP_REALERT="${WATCHDOG_FLAP_REALERT:-60}"         # then re-page every N attempts
STATE_DIR="${WATCHDOG_STATE_DIR:-/run/faucet-watchdog}"

# Poison auto-heal (step 5). Restarting zallet cannot fix a crash whose cause is a row
# in wallet.db, so the watchdog runs the repair tools when it sees that exact signature.
# Off by setting HEAL_ENABLED=0, and capped so a wrong diagnosis cannot rewrite the
# wallet on a loop - after the cap it pages instead of retrying.
HEAL_ENABLED="${WATCHDOG_HEAL_ENABLED:-1}"
HEAL_MAX_ATTEMPTS="${WATCHDOG_HEAL_MAX_ATTEMPTS:-2}"
HEAL_TOOLS_DIR="${WATCHDOG_HEAL_TOOLS_DIR:-$(dirname "$0")}"
heal_attempts=0
alerted_heal_giveup=0

# Miner stall recovery (step 6). The miner holds ONE persistent RPC connection to zebra
# and does not reconnect when zebra restarts: it loops `getblocktemplate: Peer
# disconnected` forever while its heartbeat stays fresh, so Restart=always never fires
# because the process never exits. 2026-08-18: zebra restarted, the miner went ~18h with
# no template and nothing recovered it. The heartbeat is the tell - written recently
# (alive) but lastTemplateAt old (not mining) - and a restart re-establishes the socket.
MINER_HEAL_ENABLED="${WATCHDOG_MINER_HEAL_ENABLED:-1}"
MINER_HEARTBEAT="${WATCHDOG_MINER_HEARTBEAT:-/var/lib/faucet-miner/heartbeat.json}"
MINER_UNIT="${WATCHDOG_MINER_UNIT:-zcash-testnet-miner.service}"
MINER_STALL_SECS="${WATCHDOG_MINER_STALL_SECS:-300}"          # alive but no template this long = wedged
MINER_HEARTBEAT_FRESH_SECS="${WATCHDOG_MINER_HEARTBEAT_FRESH_SECS:-60}" # older writtenAt = process itself down (Restart=always' job, not ours)
MINER_START_GRACE_SECS="${WATCHDOG_MINER_START_GRACE_SECS:-120}"  # just (re)started: give it time to fetch its first template
MINER_HEAL_MAX="${WATCHDOG_MINER_HEAL_MAX:-3}"               # then page instead of restart-looping the miner

# 0 = loop forever (production). Tests set this to run an exact number of sweeps.
MAX_TICKS="${WATCHDOG_MAX_TICKS:-0}"

# Target containers, matched by name substring so exact compose prefixes and the
# hand-run faucet-web container both resolve. Override any of these in the env.
FAUCET_MATCH="${WATCHDOG_FAUCET_MATCH:-faucet-web}"
ZEBRA_MATCH="${WATCHDOG_ZEBRA_MATCH:-zebra}"
ZALLET_MATCH="${WATCHDOG_ZALLET_MATCH:-zallet}"

log() { echo "$(date -u +%FT%TZ) watchdog: $*"; }

# Escapes the two characters that would break the JSON body. Alert text is
# ours, not user input, but a container name with a quote in it should not
# silently drop an alert.
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# Delegates to the shared sender so one URL covers every unit. Falls back to
# posting inline if alert.sh is not installed yet, so an upgrade cannot mute us.
ALERT_SH="${WATCHDOG_ALERT_SH:-$(dirname "$0")/alert.sh}"
alert() {
  log "ALERT: $1"
  if [ -x "$ALERT_SH" ]; then
    "$ALERT_SH" "$1" >/dev/null 2>&1 || log "alert send failed via $ALERT_SH"
    return 0
  fi
  [ -n "$ALERT_URL" ] || return 0
  local msg body
  msg="[zcash-faucet watchdog] $(json_escape "$1")"
  case "$ALERT_FORMAT" in
    discord) body="{\"content\":\"$msg\"}" ;;
    slack|*)  body="{\"text\":\"$msg\"}" ;;
  esac
  curl -fsS --max-time 10 -H 'content-type: application/json' \
    -d "$body" "$ALERT_URL" >/dev/null 2>&1 || log "alert webhook POST failed"
}

# First running-or-stopped container id whose name contains $1 (empty if none).
find_container() {
  docker ps -a --filter "name=$1" --format '{{.Names}}' | head -n1
}

# Ensure restart policy is unless-stopped (idempotent, cheap, reboot-safe).
ensure_restart_policy() {
  local name="$1"
  [ -n "$name" ] || return 0
  local pol
  pol="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$name" 2>/dev/null || echo '')"
  if [ "$pol" != "unless-stopped" ] && [ "$pol" != "always" ]; then
    log "setting restart=unless-stopped on $name (was '${pol:-none}')"
    docker update --restart unless-stopped "$name" >/dev/null 2>&1 || log "docker update failed on $name"
  fi
}

# Consecutive failed-start attempts per container. The count lives in memory
# first and on disk second: disk exists only so a watchdog restart does not
# forget an ongoing loop, so an unwritable state dir must degrade to "works
# until restart" rather than to "never escalates". An escalation mechanism that
# silently does nothing is precisely the failure it was built to prevent.
STATE_WRITE_OK=unknown

flap_var()  { printf 'FLAP_%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"; }
flap_file() { printf '%s/%s.flaps' "$STATE_DIR" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_')"; }

# Never trust the file. Its contents are fed to $(( )) below, and under `set -u`
# an unbound name inside arithmetic exits the shell - so a torn write (OOM, power
# loss, full disk) would put the watchdog itself into a restart loop that no
# restart could clear, leaving the box unmonitored until a human deleted a file.
# Anything that is not all digits is treated as no count at all.
flap_get() {
  local var val disk
  var="$(flap_var "$1")"
  eval "val=\${$var-}"
  if [ -n "$val" ]; then printf '%s' "$val"; return 0; fi
  disk="$(cat "$(flap_file "$1")" 2>/dev/null)"
  case "$disk" in
    ''|*[!0-9]*) printf '0' ;;
    *)           printf '%s' "$disk" ;;
  esac
}

# Memory is authoritative; the file is a best-effort copy written atomically so a
# reader never sees a half-written count.
flap_set() {
  local var f tmp
  var="$(flap_var "$1")"
  eval "$var=\$2"
  f="$(flap_file "$1")"; tmp="$f.tmp.$$"
  if mkdir -p "$STATE_DIR" 2>/dev/null && printf '%s' "$2" > "$tmp" 2>/dev/null && mv -f "$tmp" "$f" 2>/dev/null; then
    if [ "$STATE_WRITE_OK" = "no" ]; then
      log "state dir $STATE_DIR is writable again; flap counts will survive a restart"
    fi
    STATE_WRITE_OK=yes
  else
    rm -f "$tmp" 2>/dev/null
    if [ "$STATE_WRITE_OK" != "no" ]; then
      log "WARNING: cannot write $STATE_DIR - flap counts are in-memory only, so escalation still works but resets if this watchdog restarts"
    fi
    STATE_WRITE_OK=no
  fi
  return 0
}

# Start a container back up if it is not running, and report only what we can
# actually establish. Three outcomes, because two were not enough:
#
#   recovered     it is running NOW and we had been restarting it, so the start held
#   still-broken  it needed starting again, which is a loop rather than a fix
#   cannot-tell   docker could not answer, which is not the same as "it is fine"
#
# `docker start` exiting 0 means the COMMAND was accepted, not that the container
# stayed up. For a container already in 'restarting' docker is cycling it anyway,
# so the call is a no-op that always succeeds. Claiming recovery there is how the
# zallet crash loop stayed invisible: only the NEXT sweep seeing 'running' proves
# anything, so recovery is announced one tick later or not at all.
recover_if_down() {
  local name="$1"
  [ -n "$name" ] || return 0

  local state
  if ! state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null)" || [ -z "$state" ]; then
    # Could not ask. Absent container and unreachable daemon are different
    # problems and neither is evidence of health, so assert neither.
    log "cannot determine state of $name (docker inspect gave nothing) - asserting nothing"
    return 0
  fi

  local prior
  prior="$(flap_get "$name")"

  if [ "$state" = "running" ]; then
    if [ "$prior" -gt 0 ]; then
      # This is the only place a recovery claim is honest: it is up on a later
      # sweep than the one that started it.
      alert "recovered $name: running again, verified on the sweep after $prior restart attempt(s)"
      flap_set "$name" 0
    fi
    return 0
  fi

  local n=$((prior + 1))
  flap_set "$name" "$n"
  log "container $name is '$state' - starting it (consecutive attempt $n)"

  if docker start "$name" >/dev/null 2>&1; then
    log "start command accepted for $name; recovery UNCONFIRMED until a later sweep sees it running"
  else
    log "start command failed for $name (state '$state')"
  fi

  # Page on the threshold, then only periodically: an ongoing outage should keep
  # reminding us without becoming the 812-messages-a-night noise it replaces.
  if [ "$n" -eq "$FLAP_ESCALATE" ] || { [ "$n" -gt "$FLAP_ESCALATE" ] && [ $(( (n - FLAP_ESCALATE) % FLAP_REALERT )) -eq 0 ]; }; then
    alert "STILL BROKEN: $name has needed $n consecutive restarts (state '$state') - this is a crash loop, not a recovery; it will not fix itself"
  fi
}

# One string field out of the miner heartbeat, empty if absent or JSON null. grep, not a
# json parser, because the watchdog carries no such dependency and the heartbeat is our
# own flat object, one field per line.
hb_field() { grep -o "\"$1\":\"[^\"]*\"" "$MINER_HEARTBEAT" 2>/dev/null | head -n1 | cut -d'"' -f4; }

# Age in seconds of an ISO-8601 Zulu timestamp, or empty if it is absent or will not
# parse. Empty is deliberately different from a large number: "no timestamp" is not
# evidence of staleness, it is absence of evidence, and the caller distinguishes them.
ts_age() {
  local ts="$1" epoch
  [ -n "$ts" ] || { printf ''; return; }
  epoch="$(date -u -d "$ts" +%s 2>/dev/null)" || { printf ''; return; }
  printf '%s' "$(( $(date -u +%s) - epoch ))"
}

# STEP 6: MINER STALL RECOVERY. Narrow, like the poison heal. It acts ONLY on a miner
# that is provably alive (heartbeat fresh) yet not templating (lastTemplateAt stale), so
# it never touches a miner that is merely down - that is Restart=always' job - nor one
# that just (re)started and has not had time to fetch its first template. Capped, so a
# stall it cannot fix (zebra genuinely down, RPC endpoint moved) pages a human instead of
# restart-looping the miner forever.
heal_miner_if_stalled() {
  [ "$MINER_HEAL_ENABLED" = "1" ] || return 0
  [ -f "$MINER_HEARTBEAT" ] || return 0
  local key="$MINER_UNIT" written_age started_age tmpl_age

  written_age="$(ts_age "$(hb_field writtenAt)")"
  # No parseable heartbeat: cannot establish the miner is alive, so assert nothing and
  # leave a dead process to Restart=always.
  [ -n "$written_age" ] || return 0
  [ "$written_age" -le "$MINER_HEARTBEAT_FRESH_SECS" ] || return 0

  # A freshly (re)started miner has not fetched a template yet; restarting it now would
  # thrash exactly the thing a restart just fixed.
  started_age="$(ts_age "$(hb_field startedAt)")"
  [ -z "$started_age" ] || [ "$started_age" -ge "$MINER_START_GRACE_SECS" ] || return 0

  # lastTemplateAt absent/null counts as "never templated", which past the start grace is
  # itself a stall.
  tmpl_age="$(ts_age "$(hb_field lastTemplateAt)")"
  if [ -n "$tmpl_age" ] && [ "$tmpl_age" -lt "$MINER_STALL_SECS" ]; then
    # Templating normally. Clear any prior stall count so the next episode gets a full
    # budget, the same way a READY faucet resets the poison heal.
    [ "$(flap_get "$key")" = "0" ] || { flap_set "$key" 0; log "miner templating again (last ${tmpl_age}s ago); stall count reset"; }
    return 0
  fi

  local n; n=$(( $(flap_get "$key") + 1 )); flap_set "$key" "$n"
  if [ "$n" -le "$MINER_HEAL_MAX" ]; then
    log "miner stalled: alive (heartbeat ${written_age}s old) but no block template for ${tmpl_age:-never}s; restarting $MINER_UNIT ($n/$MINER_HEAL_MAX)"
    if systemctl restart "$MINER_UNIT" >/dev/null 2>&1; then
      alert "miner was stalled (heartbeat fresh, no block template for ${tmpl_age:-N/A}s) - restarted $MINER_UNIT ($n/$MINER_HEAL_MAX). Usually zebra restarted and the miner did not reconnect."
    else
      alert "miner stalled and 'systemctl restart $MINER_UNIT' FAILED ($n/$MINER_HEAL_MAX) - needs a human."
    fi
  elif [ "$n" -eq "$((MINER_HEAL_MAX + 1))" ]; then
    alert "miner STILL stalled after $MINER_HEAL_MAX restart(s) - not retrying. Likely zebra is down or the RPC endpoint moved; needs a human."
  fi
}

faucet_misses=0
unready_since=0
alerted_unready=0

# An unrecognized format still sends (a watchdog that dies on a config typo
# is worse than one that guesses), but say so, or a typo means alerts go out
# in a shape the channel rejects and nobody hears anything.
case "$ALERT_FORMAT" in
  slack|discord) : ;;
  *) log "WARNING: unknown WATCHDOG_ALERT_FORMAT '$ALERT_FORMAT', sending the slack shape (valid: slack, discord)" ;;
esac

log "starting: interval=${INTERVAL}s faucet=${FAUCET_URL} ready_grace=${READY_GRACE_SECS}s alert=${ALERT_URL:-none} format=${ALERT_FORMAT}"

ticks=0
while true; do
  ticks=$((ticks + 1))
  zebra="$(find_container "$ZEBRA_MATCH")"
  zallet="$(find_container "$ZALLET_MATCH")"
  faucet="$(find_container "$FAUCET_MATCH")"

  # 1 + 2: keep restart policy set and bring back anything that fell over.
  for c in "$zebra" "$zallet" "$faucet"; do
    ensure_restart_policy "$c"
    recover_if_down "$c"
  done

  # 3: web-app liveness. Only restart when the container claims to be running
  # but /api/health has stopped answering - a genuine hang, not a cold start.
  if [ -n "$faucet" ] && [ "$(docker inspect -f '{{.State.Status}}' "$faucet" 2>/dev/null)" = "running" ]; then
    if curl -fsS --max-time 5 "$FAUCET_URL/api/health" >/dev/null 2>&1; then
      faucet_misses=0
    else
      faucet_misses=$((faucet_misses + 1))
      log "faucet liveness miss $faucet_misses/$FAUCET_FAIL_LIMIT"
      if [ "$faucet_misses" -ge "$FAUCET_FAIL_LIMIT" ]; then
        log "restarting hung $faucet"
        docker restart "$faucet" >/dev/null 2>&1 && alert "restarted hung faucet-web after $faucet_misses missed health checks"
        faucet_misses=0
      fi
    fi
  fi

  # 4: readiness alerting. Not-ready is normal during first sync / refill, so we
  # only page when it persists past the grace window, and only once per episode.
  now="$(date -u +%s)"
  # ONE fetch, and both the verdict and the reason come out of it. This used to probe
  # and then re-fetch for the reason, which spent two sequential 8s budgets against the
  # same endpoint: when readiness was slow the second fetch timed out too, so the page
  # read "reason: unknown" precisely when a reason would have been most useful, and it
  # doubled the load on an endpoint already established as slow (#229).
  #
  # -sS not -fsS, because a 503 body carries the reason and -f discards it. The status
  # comes from -w instead, so a non-2xx is still recognised as not-ready.
  ready_body="$(curl -sS --max-time 8 -w '\n%{http_code}' "$FAUCET_URL/api/ready" 2>/dev/null)"
  ready_rc=$?
  ready_code="${ready_body##*$'\n'}"
  reason="$(printf '%s' "$ready_body" | grep -o '"reason":"[^"]*"' | head -n1 | cut -d'"' -f4)"
  # A transport failure is not an answer. Say so, rather than reporting an empty reason
  # that reads as though the app declined to explain itself.
  if [ "$ready_rc" -ne 0 ]; then reason="no answer from /api/ready (curl $ready_rc)"; fi
  case "$ready_code" in 2*) ready_ok=1 ;; *) ready_ok=0 ;; esac
  if [ "$ready_rc" -eq 0 ] && [ "$ready_ok" = "1" ]; then
    if [ "$alerted_unready" = "1" ]; then alert "faucet is READY again"; fi
    unready_since=0
    alerted_unready=0
  else
    [ "$unready_since" = "0" ] && unready_since="$now"
    elapsed=$((now - unready_since))
    if [ "$elapsed" -ge "$READY_GRACE_SECS" ] && [ "$alerted_unready" = "0" ]; then
      alert "faucet not ready for ${elapsed}s (reason: ${reason:-unknown})"
      alerted_unready=1
    fi
  fi

  # 5: POISON AUTO-HEAL. The one thing steps 1-4 could not do, and the reason
  # 2026-08-17 was a ten-hour outage instead of a five-minute one.
  #
  # zallet stores the transaction ids it wants data for. When one expired unmined and
  # zebra has since dropped it, the answer is `-5 No such mempool or main chain
  # transaction`; zaino calls that unrecoverable rather than not-found, and zallet
  # exits. Step 2 then restarts it into the identical death, forever, because the input
  # that kills it is STORED STATE. 162 restarts, and every one of them looked like a
  # successful self-heal.
  #
  # So restarting is not enough here: the poison has to be cleared. That is what the
  # deploy/z3/zallet-*.sh tools do, and this runs them.
  #
  # NARROW ON PURPOSE. It fires only when the log carries that exact signature AND the
  # app is telling us it cannot read the wallet. Anything else - a hung node, a full
  # disk, a genuine zebra outage - is left to steps 1-4 and the pager, because a
  # watchdog that reaches for a database repair whenever something looks wrong is worse
  # than one that does nothing.
  #
  # IT ALWAYS ALERTS, including on success. A silent self-heal is how 812 restarts went
  # unnoticed once already; a heal that fixed something is exactly what an operator
  # needs to know, and repeated heals are the signal that the tap upstream is leaking.
  #
  # AND IT GIVES UP. After HEAL_MAX_ATTEMPTS it stops and pages instead of rewriting
  # wallet.db on a loop: at that point the diagnosis is wrong and thrashing the database
  # is the more dangerous of the two options.
  if [ -n "$zallet" ] && [ "$ready_ok" = "0" ] && [ "$HEAL_ENABLED" = "1" ]; then
    case "$reason" in
      *"balance unknown"*|*"no answer"*)
        if docker logs --tail 40 "$zallet" 2>&1 | grep -q "No such mempool or main chain transaction"; then
          if [ "$heal_attempts" -ge "$HEAL_MAX_ATTEMPTS" ]; then
            if [ "$alerted_heal_giveup" = "0" ]; then
              alert "zallet poison persists after $heal_attempts repair attempt(s) - NOT retrying, needs a human. reason: ${reason:-unknown}"
              alerted_heal_giveup=1
            fi
          else
            heal_attempts=$((heal_attempts + 1))
            log "zallet poison signature detected; running repair $heal_attempts/$HEAL_MAX_ATTEMPTS"
            # Stopped first, or sqlite and the wallet fight over the file. `docker stop`
            # beats the restart policy: it marks the container stopped, so step 2's
            # recover_if_down is what deliberately brings it back afterwards.
            docker stop "$zallet" >/dev/null 2>&1
            heal_out=""
            for tool in zallet-abandon-expired-txs.sh zallet-drop-unfetchable-queue.sh; do
              if [ -x "$HEAL_TOOLS_DIR/$tool" ] || [ -f "$HEAL_TOOLS_DIR/$tool" ]; then
                heal_out="$heal_out $(bash "$HEAL_TOOLS_DIR/$tool" 2>&1 | tail -3 | tr '\n' ' ')"
              else
                log "WARNING: $HEAL_TOOLS_DIR/$tool missing, cannot heal"
              fi
            done
            docker start "$zallet" >/dev/null 2>&1
            alert "zallet was crash-looping on dropped-transaction poison; ran the repair tools (attempt $heal_attempts/$HEAL_MAX_ATTEMPTS) and restarted it.${heal_out}"
          fi
        fi
        ;;
    esac
  elif [ "$ready_ok" = "1" ]; then
    # A ready faucet is the only thing that proves a heal worked, so the budget resets
    # here rather than on a timer. An episode that recovers gets a full budget next time;
    # one that never recovers keeps its spent count and stays given-up.
    heal_attempts=0
    alerted_heal_giveup=0
  fi

  # 6: miner stall recovery. Independent of the faucet's readiness - the miner funds the
  # reserve but a stalled miner does not gate drips, so this runs every sweep on its own
  # signal (the heartbeat) rather than off /api/ready.
  heal_miner_if_stalled

  # Bounded only under test. Production leaves MAX_TICKS at 0 and never exits,
  # and the sleep is skipped on the final tick so a suite is not paying for it.
  if [ "$MAX_TICKS" -gt 0 ] && [ "$ticks" -ge "$MAX_TICKS" ]; then
    break
  fi
  sleep "$INTERVAL"
done
