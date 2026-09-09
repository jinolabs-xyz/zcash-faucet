# shellcheck shell=bash
# Claims the repo makes about ITSELF, in more than one file, where the two can drift
# apart silently. Nothing here touches a box, a container or a stub: every assertion
# reads the checked-in files.
#
# Why this suite exists. #257 found CI testing on Node 23 while production shipped
# node:22-slim, so every green suite was green on a runtime that does not exist in
# production. It fixed the five pins in ci.yml. It did not fix live-smoke.yml, which
# was still on 23, and nothing noticed for the same reason nothing noticed the first
# time: the agreement was a convention, not a check.
#
# That is the fourth detector-before-actor case in this repo. Fixing the instances you
# can see leaves the next one to be found by an incident. So the RULE gets encoded
# here, and it costs one grep per workflow.

echo "== repo: every workflow tests on the runtime production actually ships"
# The Dockerfile is the authority, because it is what runs. Both stages are read: a
# build stage on a different major than the run stage compiles against one runtime and
# executes on another, which is the same class of problem one layer down.
DOCKER_MAJORS="$(grep -oE '^FROM node:[0-9]+' "$REPO/Dockerfile" | grep -oE '[0-9]+$' | sort -u)"
check "the Dockerfile names a node major at all" "[ -n \"$DOCKER_MAJORS\" ]"
check "and every Dockerfile stage agrees on ONE major, so build and run cannot differ" \
  "[ \"\$(printf '%s\\n' $DOCKER_MAJORS | wc -l | tr -d ' ')\" = '1' ]"
PROD_MAJOR="$(printf '%s\n' "$DOCKER_MAJORS" | head -1)"

# Every workflow, found by glob rather than by a list. A list is the thing that missed
# live-smoke.yml: a new workflow would be absent from it and pass by omission.
WF_COUNT=0
WF_BAD=""
for wf in "$REPO"/.github/workflows/*.yml "$REPO"/.github/workflows/*.yaml; do
  [ -e "$wf" ] || continue
  WF_COUNT=$((WF_COUNT + 1))
  # setup-node accepts "22", "22.x", "22.18.0" and lts/*. Only a bare major or a
  # major-prefixed version can be compared to the Dockerfile; anything else is
  # reported rather than guessed at, because silently skipping a form we do not
  # understand is how a check keeps passing while covering less.
  while IFS= read -r ver; do
    [ -n "$ver" ] || continue
    case "$ver" in
      "$PROD_MAJOR"|"$PROD_MAJOR".*) ;;
      *) WF_BAD="$WF_BAD $(basename "$wf"):$ver" ;;
    esac
  done <<EOF
$(grep -oE '^[[:space:]]*node-version:[[:space:]]*[^[:space:]#]+' "$wf" | sed -E 's/.*node-version:[[:space:]]*//' | tr -d '"'"'"'')
EOF
done

# A count assertion, because zero workflows found would make the loop above vacuous
# and the check would pass having compared nothing. That is the exact shape of the
# false pass this suite is here to prevent.
check "workflows were actually found and read" "[ '$WF_COUNT' -gt 0 ]"
check "every node-version pin matches the Dockerfile's node $PROD_MAJOR" \
  "[ -z '$WF_BAD' ] || { echo '   mismatched:$WF_BAD'; false; }"

echo "== repo: CI lints EVERY tracked shell script, not a glob's worth of them"
# WHY THIS IS A RULE AND NOT A ONE-TIME FIX. CI ran `shellcheck -S warning deploy/deploy.sh
# deploy/z3/*.sh`, which is 22 of this repo's 41 tracked .sh files. The 19 it missed are the
# whole test harness - and sixteen of those open with `# shellcheck shell=bash`, a directive
# that does nothing unless a linter is reading the file. People wrote it believing they were
# covered.
#
# The harness is the thing that caught the $HERE bug shellcheck cannot see at any severity,
# so the least-linted code in the tree was the code the gate depends on. A glob cannot say
# which files it failed to match, so the gap was invisible from inside CI: the step was
# green, and it was green about 22 files.
#
# The rule is the enumeration, not the current file count. `git ls-files` covers a new
# script the day it is added; a pattern covers it the day somebody remembers.
# Asserted against the whole file rather than an extracted step. The first attempt pulled the
# step out with `awk '/shellcheck/,/- name:/'`, and ci.yml's own header comment on line 1 says
# the word shellcheck, so the range started at line 1 and the assertions read a region that
# had nothing to do with the step. It passed. Anchoring on the invocation itself has no such
# ambiguity, and there is only one shellcheck step to be confused about.
CI_YML="$REPO/.github/workflows/ci.yml"
check "ci.yml still runs shellcheck at all" "grep -q 'shellcheck -S' '$CI_YML'"
check "and it enumerates the files from git rather than globbing a directory" \
  "grep -q 'git ls-files -z' '$CI_YML'"
check "and NO shellcheck invocation uses the deploy/z3/*.sh glob that silently missed 19 files" \
  "! grep -qE 'shellcheck[^|]*deploy/z3/\*\.sh' '$CI_YML'"
# THE FLOOR IS PART OF THE RULE. xargs on an empty list runs shellcheck with no arguments, so
# a checkout that produced no files would pass while linting nothing - the same shape as the
# two empty sha256sum listings that compare equal in drift.
check "and it refuses a suspiciously short file list instead of linting nothing" \
  "grep -qE 'ge 30' '$CI_YML'"

echo "== repo: the npm test script's floor is compatible with the pinned major"
# `npm test` runs .ts through `node --test`, which needs type stripping. That is
# unflagged from 22.18. Below the floor the script needs --experimental-strip-types,
# so a pin BELOW 22 would make every suite fail to start rather than fail honestly.
check "the pinned major is at least 22, the floor for unflagged type stripping" \
  "[ '$PROD_MAJOR' -ge 22 ]"

echo "== repo: the miner heartbeat path agrees in all three places that name it"
# Three files must agree on one path: the contract, the systemd unit that writes there, and
# the compose mount the faucet reads through. Nothing enforced that, and a rename in one of
# them leaves the reader watching a file nobody writes. That reports cannot-verify forever,
# which is the hardest state to notice because it is not an error.
HB_DOC="$REPO/deploy/z3/MINER-HEARTBEAT.md"
HB_UNIT="$REPO/deploy/z3/zcash-testnet-miner.service"
HB_COMPOSE="$REPO/deploy/z3/docker-compose.faucet.yml"
HB_SRC="$REPO/deploy/z3/miner/src/heartbeat.rs"
HB_PATH="$(sed -n 's/^Environment=MINER_HEARTBEAT_PATH=//p' "$HB_UNIT" | head -n1)"
HB_STATEDIR="$(sed -n 's/^StateDirectory=//p' "$HB_UNIT" | head -n1)"
HB_DIR="$(dirname "${HB_PATH:-/nowhere}")"

check "the contract document exists" "[ -f '$HB_DOC' ]"
check "the unit sets MINER_HEARTBEAT_PATH" "[ -n '$HB_PATH' ]"
check "the unit declares a StateDirectory, so the dir is created and owned before it writes" \
  "[ -n '$HB_STATEDIR' ]"
check "and the StateDirectory is the directory that path lives in" \
  "[ '/var/lib/$HB_STATEDIR' = '$HB_DIR' ]"
check "the compose file mounts that directory into the faucet" \
  "grep -q '$HB_DIR:$HB_DIR' '$HB_COMPOSE'"
check "and mounts it READ-ONLY, so the reader cannot forge the signal it reports" \
  "grep -q '$HB_DIR:$HB_DIR:ro' '$HB_COMPOSE'"
check "the contract document names the same path" "grep -q '$HB_PATH' '$HB_DOC'"

echo "== repo: the heartbeat has no error-message channel, only a stage token"
# It is served from a public endpoint, and an error MESSAGE is where an RPC URL carrying
# credentials in its userinfo ends up. The type is the guard: a Rust static string literal
# cannot hold a formatted error, so this is structural rather than a habit to remember.
check "the writer emits lastErrorStage" "grep -q lastErrorStage '$HB_SRC'"
check "and no message or text error field exists to leak into" \
  "! grep -qE 'lastError(Message|Text)' '$HB_SRC'"
check "and the stage field cannot hold a formatted string" \
  "grep -q 'last_error_stage: Option<&' '$HB_SRC'"

echo "== repo: every service routes its failures somewhere"
# App found faucet-box-report.service had no OnFailure while every other service did.
# Fixing that instance leaves the next one to be found the same way, so the rule is here.
#
# The template is excluded because it IS the handler: pointing it at itself is a loop.
# That exclusion is also why this checks for a REAL directive rather than the string:
# my first look used `grep -l OnFailure` and matched the COMMENT in the template's own
# header, so the template appeared to have one and the actual gap was masked.
SVC_MISSING=""
SVC_COUNT=0
for f in "$REPO"/deploy/z3/*.service; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  case "$name" in faucet-alert@.service) continue ;; esac
  SVC_COUNT=$((SVC_COUNT + 1))
  # SECTION-AWARE, because systemd only honours OnFailure in [Unit]. Put it under
  # [Service] and systemd logs "Unknown key name 'OnFailure' in section 'Service',
  # ignoring" and drops it, so the unit routes its failures nowhere while satisfying a
  # plain grep. App proved that: they moved the directive and this rule still read
  # 18 passed 0 failed.
  #
  # That is this rule's own bug one level in. I had already caught `grep -l OnFailure`
  # matching the COMMENT in the template header and tightened it to a real directive,
  # and the tightened version still only proved the STRING was present rather than that
  # the BEHAVIOUR was configured.
  #
  # A malformed section header fails this closed, reporting the unit as missing a
  # handler, which is the safe direction for a check about alerting.
  awk '/^\[/{sec=$0} sec=="[Unit]" && /^OnFailure=/{f=1} END{exit !f}' "$f" \
    || SVC_MISSING="$SVC_MISSING $name"
done
check "services were actually found and read" "[ '$SVC_COUNT' -gt 0 ]"
check "every service has an OnFailure handler" \
  "[ -z '$SVC_MISSING' ] || { echo '   missing:$SVC_MISSING'; false; }"
# The handler has to be the one that exists, not any string.
check "and it routes to the alert template this repo ships" \
  "! grep -hE '^OnFailure=' \"$REPO\"/deploy/z3/*.service | grep -qv 'faucet-alert@%n.service'"
# The exclusion above stops the template being REQUIRED to have a handler; nothing stopped
# it HAVING one, and a handler that alerts on its own failure loops. App raised this as a
# speculative edge and explicitly did not call it a finding. It is one line to close, and
# an alerting loop on a box whose alerts already reach nobody is not a thing to leave
# expressible.
check "and the alert template does not route to itself, which would loop" \
  "! awk '/^\\[/{sec=\$0} sec==\"[Unit]\" && /^OnFailure=/{f=1} END{exit !f}' \"$REPO/deploy/z3/faucet-alert@.service\""

# A unit that points at documentation which does not exist sends an operator looking for a
# file that was never written, at the moment they are least able to afford the detour.
# This is here because I did exactly that: ctaz-node.service shipped with
# Documentation=file:.../CTAZ.md before CTAZ.md existed, and nothing objected.
DOC_MISSING=""
DOC_COUNT=0
for f in "$REPO"/deploy/z3/*.service; do
  [ -e "$f" ] || continue
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    DOC_COUNT=$((DOC_COUNT + 1))
    [ -f "$REPO/deploy/z3/$(basename "$ref")" ] \
      || DOC_MISSING="$DOC_MISSING $(basename "$f")->$(basename "$ref")"
  done <<EOF
$(sed -n 's|^Documentation=file:||p' "$f")
EOF
done
# No units referencing docs is a legitimate state, so this does not require a count. It
# requires that every reference which EXISTS resolves.
check "every Documentation= file a unit points at actually exists" \
  "[ -z '$DOC_MISSING' ] || { echo '   dangling:$DOC_MISSING'; false; }"

echo "== repo: StartLimit* keys are in [Unit], the only section systemd reads them in"
# faucet-watchdog.service had StartLimitIntervalSec in [Service], where systemd
# discards it: `Unknown key name 'StartLimitIntervalSec' in section 'Service',
# ignoring.` Confirmed against systemd 255 rather than looked up, both directions:
# the same key in [Unit] draws no complaint.
#
# Worth a guard rather than a one-off fix because the failure is SILENT. The unit
# loads, the service runs, and the setting simply does nothing. Nothing in a deploy
# surfaces an ignored key, so the only way this comes back is quietly.
#
# `find` rather than a glob, and the first version of this check is why. It used
# "$REPO/deploy"/**/*.service, which without globstar reaches exactly one directory
# deep and silently skipped every .timer. The check passed against a file I had
# deliberately broken.
UNIT_FILES="$(find "$REPO/deploy" \( -name '*.service' -o -name '*.timer' \) | sort)"
BADSEC=""
UNITS_SCANNED=0
for u in $UNIT_FILES; do
  UNITS_SCANNED=$((UNITS_SCANNED + 1))
  hit="$(awk '/^\[/ { sec = $0 } /^[[:space:]]*StartLimit/ { if (sec != "[Unit]") print FILENAME ":" FNR " " sec }' "$u")"
  [ -n "$hit" ] && BADSEC="$BADSEC $hit"
done
check "no StartLimit* key sits outside [Unit], where systemd would ignore it" \
  "[ -z '$BADSEC' ] || { echo '   wrong section:$BADSEC'; false; }"

# THE CONTROL, and it counts what the LOOP ABOVE ACTUALLY ITERATED rather than
# re-deriving the set. The first version ran its own `ls` over a different pattern,
# so it proved units exist on disk and said nothing about whether the scanner read
# any of them. A control that does not exercise the same path as the thing it
# guards is decoration: mine reported a healthy count while the scanner was reading
# nothing, which is the exact false pass this suite exists to prevent.
check "and the scan actually iterated the units, so a clean result means something" \
  "[ '$UNITS_SCANNED' -ge 8 ] || { echo '   only scanned $UNITS_SCANNED unit(s)'; false; }"

echo "== repo: the CI token is read-only, and a new workflow cannot quietly widen it"
# Nothing in ci.yml calls the GitHub API, but without a permissions block every job ran
# with the repository default, handed to code from a pull-request branch (register #27).
for wf in "$REPO"/.github/workflows/*.yml; do
  name="$(basename "$wf")"
  check "$name declares a permissions block" "grep -q '^permissions:' '$wf'"
  check "$name grants contents no more than read" "grep -A 4 '^permissions:' '$wf' | grep -q 'contents: read'"
  check "$name grants nothing write at the top level" "! grep -A 6 '^permissions:' '$wf' | grep -qE ': *write'"
done

echo "== repo: the off-box probe cannot pass without probing (risk register #17)"
# It is the only signal that has ever reached us unprompted. Three ways it used to go
# green while watching nothing: no FAUCET_LIVE_URL (skipped, exit 0), an escape hatch
# that never expired, and a schedule GitHub had quietly stopped running.
#
# THESE RUN THE WORKFLOW'S OWN SHELL, they do not grep its prose. The first version of
# this block matched the log messages, so changing `exit 1` to `exit 0` in the step it
# guards left every check green: the fix was not gated by the thing asserting it.
LS="$REPO/.github/workflows/live-smoke.yml"
mk_scratch "${TMPDIR:-/tmp}/repo-livesmoke.XXXXXX"
# Plain text, not PyYAML: the harness image has python3 but no yaml module, and this
# only has to find a `run: |` block under a named step.
python3 - "$LS" "$T" <<'PY'
import sys, pathlib, textwrap
lines = open(sys.argv[1]).read().splitlines()
out = pathlib.Path(sys.argv[2])

def script(name):
    i = next(k for k, l in enumerate(lines) if l.strip().startswith("- name:") and name in l)
    j = next(k for k in range(i, len(lines)) if lines[k].strip() in ("run: |", "run: |-"))
    body, indent = [], None
    for l in lines[j + 1:]:
        if l.strip() == "":
            body.append("")
            continue
        lead = len(l) - len(l.lstrip())
        if indent is None:
            indent = lead
        if lead < indent:
            break
        body.append(l[indent:])
    return "\n".join(body).rstrip() + "\n"

(out / "probe-step.sh").write_text(script("probe the live faucet"))
(out / "page-step.sh").write_text(script("page on"))
PY
check "the workflow's two steps could be extracted, so what follows is the shipped script" \
  "[ -s '$T/probe-step.sh' ] && [ -s '$T/page-step.sh' ]"

# The probe step, run for real. `node scripts/live-probe.mjs` is never reached in these
# two cases, which is the point: both must decide before probing anything.
( cd "$REPO" && SMOKE_URL="" SMOKE_DISABLED="" bash "$T/probe-step.sh" > "$T/nourl.log" 2>&1 )
check "an unset FAUCET_LIVE_URL FAILS the step, rather than skipping green" "[ $? -ne 0 ]"
check "and says what it has been doing" "grep -q 'probed NOTHING' '$T/nourl.log'"
( cd "$REPO" && SMOKE_URL="" SMOKE_DISABLED="1" bash "$T/probe-step.sh" > "$T/off1.log" 2>&1 )
check "the named off switch exits 0 with no URL" "[ $? -eq 0 ] && grep -q 'deliberately off' '$T/off1.log'"
( cd "$REPO" && SMOKE_URL="https://example.invalid" SMOKE_DISABLED="1" bash "$T/probe-step.sh" > "$T/off2.log" 2>&1 )
check "and ALSO with a URL set, which is when a maintenance window needs it" "[ $? -eq 0 ] && grep -q 'deliberately off' '$T/off2.log'"

# The page step, run for real against a stub gh/curl. This is the 30-minute rule.
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
# Ignores the --jq filter and prints the fixture the case chose, which is what the
# filter would have selected.
cat "${STUB_PREV_JSON:?}"
GH
cat > "$T/bin/curl" <<'CURL'
#!/usr/bin/env bash
echo "curl $*" >> "${STUB_CURL_LOG:?}"
exit 0
CURL
chmod +x "$T/bin/gh" "$T/bin/curl"
export STUB_CURL_LOG="$T/curl.log"
page_run() { # $1 = fixture json, sets $T/page.log
  : > "$STUB_CURL_LOG"
  printf '%s' "$1" > "$T/prev.json"
  ( cd "$REPO" && PATH="$T/bin:$BASE_PATH" STUB_PREV_JSON="$T/prev.json" \
      ALERT_URL="https://hook.example/x" ALERT_FORMAT="" GH_TOKEN=x SMOKE_URL="https://f.example" \
      GITHUB_RUN_ID=999 GITHUB_SERVER_URL=https://github.com GITHUB_REPOSITORY=o/r \
      bash "$T/page-step.sh" > "$T/page.log" 2>&1 )
}
old="$(date -u -d '-300 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-300M +%Y-%m-%dT%H:%M:%SZ)"
recent="$(date -u -d '-10 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)"
page_run "{\"conclusion\":\"success\",\"databaseId\":1,\"createdAt\":\"$old\"}"
check "a previous SUCCESS does not page: one red run is a blip" "! grep -q 'curl ' '$STUB_CURL_LOG'"
page_run "{\"conclusion\":\"failure\",\"databaseId\":1,\"createdAt\":\"$recent\"}"
check "two failures only 10 minutes apart do not page: the rule is 30 MINUTES, not two runs" "! grep -q 'curl ' '$STUB_CURL_LOG'"
page_run "{\"conclusion\":\"failure\",\"databaseId\":1,\"createdAt\":\"$old\"}"
check "two failures spanning 300 minutes DO page" "grep -q 'curl ' '$STUB_CURL_LOG'"
check "and the message carries the real span, not an assumed 30" "grep -qE 'spanning 3[0-9][0-9]\+ minutes' '$T/page.log' '$STUB_CURL_LOG'"
check "and it says the schedule is not keeping its cron" "grep -q 'not the 15 the cron asks for' '$T/page.log'"
page_run "{}"
check "an unreadable previous run PAGES rather than exiting quietly" "grep -q 'curl ' '$STUB_CURL_LOG'"
check "the query asks only for COMPLETED runs, so an overlapping queued one cannot hide an outage" \
  "grep -q -- '--status completed' '$T/page-step.sh'"

check "the probe's un-ready hatch is a DATE, not a value that never expires" \
  "grep -q 'not a YYYY-MM-DD date, so it is IGNORED' '$REPO/scripts/live-probe.mjs' && ! grep -q 'SMOKE_ALLOW_UNREADY === \"1\"' '$REPO/scripts/live-probe.mjs'"
check "and the runbook an operator opens mid-incident names the date form, not the dead =1" \
  "grep -q 'FAUCET_LIVE_ALLOW_UNREADY' '$REPO/OPERATIONS.md' && ! grep -q 'FAUCET_LIVE_ALLOW_UNREADY=1' '$REPO/OPERATIONS.md'"
check "the workflow's own explorer skip is NOT set in the workflow, so the real run still checks it" \
  "! grep -q 'SMOKE_SKIP_EXPLORER' '$LS'"
check "the probe watches the certificate, which nothing on the box can see" \
  "grep -q 'the TLS certificate has more than' '$REPO/scripts/live-probe.mjs' && grep -q 'SMOKE_TLS_MIN_DAYS' '$REPO/scripts/live-probe.mjs'"
check "and the Caddyfile says where certificate expiry is watched from" \
  "grep -q 'SMOKE_TLS_MIN_DAYS' '$REPO/deploy/z3/Caddyfile'"
check "the probe has tests, and npm test runs them" \
  "[ -f '$REPO/scripts/live-probe.test.mjs' ] && grep -q 'scripts/\*\*/\*.test.mjs' '$REPO/package.json'"
