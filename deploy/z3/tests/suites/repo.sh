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
# THE BASE IMAGES ARE PINNED BY DIGEST (risk register II, R-7). A tag-only FROM never
# moved on the box: nothing pulled it again and dependabot preserves tag precision, so
# a node 24.x or caddy 2.x security release produced no PR and no fetch. With a digest,
# dependabot bumps the line and `compose build --pull` fetches it. Both stages must
# carry the SAME digest, or build and run differ in a way `docker images` will not show.
# shellcheck disable=SC2034 # read inside check's eval
NODE_DIGESTS="$(grep -oE '^FROM node:[^ ]+@sha256:[0-9a-f]{64}' "$REPO/Dockerfile" | sed 's/^FROM //' | sort -u)"
check "every FROM node in the Dockerfile is pinned by digest" \
  "[ \"\$(grep -cE '^FROM node:' '$REPO/Dockerfile')\" -eq \"\$(grep -cE '^FROM node:[^ ]+@sha256:[0-9a-f]{64}' '$REPO/Dockerfile')\" ]"
check "and both stages carry one and the same digest" "[ \"\$(printf '%s\n' \"\$NODE_DIGESTS\" | grep -c .)\" -eq 1 ]"
check "caddy in the compose file is pinned by digest" \
  "grep -qE '^ +image: caddy:[^ ]+@sha256:[0-9a-f]{64}\$' '$REPO/deploy/z3/docker-compose.faucet.yml'"
check "every node-version pin matches the Dockerfile's node $PROD_MAJOR" \
  "[ -z '$WF_BAD' ] || { echo '   mismatched:$WF_BAD'; false; }"

echo "== repo: every workflow job carries a timeout, so a hang costs minutes and not an afternoon"
# GitHub's default job timeout is six hours. A `node --test` that leaked a listener after a
# red assertion held a runner that long (#481); #490 closed that leak and this is the layer
# under it (#496). Counted per job by the `runs-on:` line, anchored so the header comment
# that names the key does not count as a job having it.
WF_NO_TIMEOUT=""
for wf in "$REPO"/.github/workflows/*.yml "$REPO"/.github/workflows/*.yaml; do
  [ -e "$wf" ] || continue
  # AT THE JOB'S OWN INDENT. Steps accept the same key, and the first cut counted any
  # depth, so a job with no budget and one slow step carrying `timeout-minutes` read as
  # covered - the exact job that sits under the six-hour default. A budget counts only
  # on a line indented exactly like that file's `runs-on:` lines, and only when it is a
  # positive literal: `0` is not a budget, and an expression or a quoted string is
  # deliberately not accepted rather than guessed at.
  # Two passes over the file, so a budget written above its runs-on line counts too, and
  # a trailing `# measured ...` comment is allowed: the header asks for the measurement
  # on that line, and the first cut reds exactly that.
  tally="$(awk '
    { line[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) if (line[i] ~ /^[[:space:]]+runs-on:/) {
        match(line[i], /^[[:space:]]+/); seen[RLENGTH] = 1; jobs++
      }
      for (i = 1; i <= NR; i++)
        if (line[i] ~ /^[[:space:]]+timeout-minutes:[[:space:]]*[1-9][0-9]*[[:space:]]*(#.*)?$/) {
          match(line[i], /^[[:space:]]+/); if (seen[RLENGTH]) budgets++
        }
      printf "%d %d", budgets + 0, jobs + 0
    }' "$wf")"
  budgets="${tally% *}"; jobs="${tally#* }"
  # A file with no runs-on has no job this check can speak to: a caller of a reusable
  # workflow (`uses:` at job level) is the legitimate case and cannot carry a budget. None
  # exists today; the day one does, exclude it here by name rather than loosening the rule.
  [ "$jobs" -gt 0 ] || WF_NO_TIMEOUT="$WF_NO_TIMEOUT $(basename "$wf"):no-runs-on-lines"
  [ "$budgets" -eq "$jobs" ] || WF_NO_TIMEOUT="$WF_NO_TIMEOUT $(basename "$wf"):$budgets/$jobs"
done
check "every job in every workflow has a numeric timeout-minutes" \
  "[ -z '$WF_NO_TIMEOUT' ] || { echo '   without:$WF_NO_TIMEOUT'; false; }"

# THE IMAGE SCANNER IS A GATE, NOT A REPORT (R-42, review). trivy's default exit code is
# 0, so a step without `exit-code: "1"` prints findings and blocks nothing, and a
# deleted step blocks nothing either; both read green to every other check here.
CIWF="$REPO/.github/workflows/ci.yml"
check "the image job scans the built image with trivy-action, pinned" \
  "grep -qE '^ *uses: aquasecurity/trivy-action@[0-9a-f]{40} # v' '$CIWF'"
check "and the scan is a gate: exit-code 1, on CRITICAL, fixable only" \
  "awk '/uses: aquasecurity\\/trivy-action@/{f=1} f&&/exit-code: \"1\"/{e=1} f&&/severity: CRITICAL/{s=1} f&&/ignore-unfixed: true/{u=1} END{exit !(e&&s&&u)}' '$CIWF'"
check "and it scans the image this job built, not a registry tag" \
  "grep -qE '^ *image-ref: faucet-ci-check:' '$CIWF'"
# THE RUNTIME IS NOT ROOT IN A WRITABLE CONTAINER (R-10). The compose file, the
# Dockerfile and the CI image job each carry half the promise; these keep them saying
# the same thing, because a compose line quietly dropped would run the app as root
# again with nothing red anywhere.
CIWF="$REPO/.github/workflows/ci.yml"
COMPOSE_F="$REPO/deploy/z3/docker-compose.faucet.yml"
faucet_svc() { awk '/^  faucet:/{f=1} /^  caddy:/{f=0} f' "$COMPOSE_F"; }
check "the compose faucet service is read-only with every capability dropped" \
  "faucet_svc | grep -q '^    read_only: true' && faucet_svc | grep -q 'cap_drop: \\[ALL\\]'"
check "and adds back only the four the root-to-node hand-off needs" \
  "[ \"\$(faucet_svc | grep -oE 'cap_add: \\[[A-Z, ]+\\]')\" = 'cap_add: [CHOWN, FOWNER, SETUID, SETGID]' ]"
check "and mounts a tmpfs where Next and node write, so read-only is not a boot failure" \
  "faucet_svc | grep -q '^      - /app/.next/cache' && faucet_svc | grep -q '^      - /tmp'"
check "and inherits no-new-privileges from the shared anchor, so a child cannot regain what setpriv gave up" \
  "faucet_svc | grep -q '^    <<: \\*common' && awk '/^x-common:/{f=1} /^services:/{f=0} f' \"\$COMPOSE_F\" | grep -q 'security_opt: \\[no-new-privileges:true\\]'"
check "the Dockerfile's entrypoint is the script that drops root, and node is still the command" \
  "grep -q '^ENTRYPOINT \\[\"/app/docker-entrypoint.sh\"\\]' '$REPO/Dockerfile' && grep -q '^CMD \\[\"node\"' '$REPO/Dockerfile' && grep -q 'exec setpriv --reuid=node --regid=node' '$REPO/docker-entrypoint.sh'"
check "and the build stage prunes devDependencies before the run stage copies it" \
  "grep -q 'npm prune --omit=dev' '$REPO/Dockerfile'"
echo "== repo: the readiness stub publishes the SHAPE the app does, or the suite guards a fiction"
# 2026-09-20: the fork detector (#533, R-20) had NEVER RUN. The rung greps flat referenceHeight and
# referenceHash; #700 published a NESTED forkReference. Both halves merged, R-20 read done, and the
# rung said nothing on every sweep since. FOUR CASES COVERED IT AND ALL FOUR PASSED - because the
# STUB emitted the flat pair too. A double that agrees with the test instead of with the producer
# makes a green suite around a dark feature, and nothing here compared the two.
#
# Helpers rather than inline check strings: check() is `eval` in the CURRENT shell, so an `exit`
# inside one ends the whole suite - which it did, silently, leaving no total at all.
STUBC="$REPO/deploy/z3/tests/stubs/curl"
FORKREF="$REPO/src/lib/zcash/forkReference.ts"
READYRT="$REPO/src/app/api/ready/route.ts"
stub_json() { tr -d '\\' < "$STUBC"; }
stub_fork_obj() { stub_json | grep '"forkReference":'; }
fork_fields_declared() {
  local k ok=1
  for k in height hash ageSeconds depth; do
    # PRESENT, not "if present": a vacuous pass here is what let the flat/nested mismatch ship.
    [ "$(stub_fork_obj | grep -c "\"$k\":")" -gt 0 ] || { ok=0; continue; }
    grep -qE "^  ${k}[?]?:" "$FORKREF" || ok=0
  done
  [ "$ok" = 1 ]
}
fork_fields_present() {
  local k ok=1
  for k in height hash ageSeconds; do [ "$(stub_fork_obj | grep -c "\"$k\":")" -gt 0 ] || ok=0; done
  [ "$ok" = 1 ]
}
code_only() { grep -vE '^[[:space:]]*(#|//|\*|/\*)' "$1"; }
has_code() { [ "$(code_only "$1" | grep -c "$2")" -gt 0 ]; }
check "the app publishes a forkReference on /api/ready" "has_code '$READYRT' forkReference"
check "the readiness stub emits that same object, not a shape of its own" "has_code '$STUBC' forkReference"
check "and the watchdog reads that same object" "has_code '$REPO/deploy/z3/watchdog.sh' forkReference"
# FIELD BY FIELD. A rename on either side goes red here rather than going quiet on a box: the stub
# cannot emit a field the app does not declare, and the three the rung reads must exist in the stub.
check "every field the stub emits is declared on the app's ForkReference" "fork_fields_declared"
check "and the three the rung actually reads are present in the stub" "fork_fields_present"

echo "== repo: the audit gate says WHICH failure it is, because npm exits 1 for both"
# 2026-09-19: npm returned 503 from the advisory endpoint during maintenance, `npm audit
# --audit-level=high` exited 1, and main went red with a message that reads like a security finding.
# The control was already in the run history - the SAME sha ran green at 17:03 and red at 17:15 -
# so nothing about the tree had changed. A security gate that reddens for a reason unrelated to
# security is one people learn to skim, and skimming is how a real advisory gets waved through.
AUDITGATE="$REPO/.github/scripts/npm-audit-gate.sh"
mk_scratch "${TMPDIR:-/tmp}/repo-auditgate.XXXXXX"
printf '{"error":{"code":"E503","summary":"503 Service Unavailable - POST /-/npm/v1/security/advisories/bulk"}}' > "$T/err.json"
printf '{"auditReportVersion":2,"metadata":{"vulnerabilities":{"low":2,"moderate":1,"high":0,"critical":0}}}' > "$T/clean.json"
printf '{"auditReportVersion":2,"metadata":{"vulnerabilities":{"low":0,"moderate":0,"high":1,"critical":2}}}' > "$T/bad.json"
ag() { NPM_AUDIT_CMD="cat $T/$1" NPM_AUDIT_ATTEMPTS=2 NPM_AUDIT_BACKOFF=0 bash "$AUDITGATE" 2>&1; }

check "the gate is a script in the repo, so it can be driven by a test at all" \
  "[ -f '$AUDITGATE' ] && grep -q 'npm-audit-gate.sh' '$REPO/.github/workflows/ci.yml'"
# THE DISTINCTION THIS EXISTS FOR, driven both ways from fixtures with no network.
check "an unreachable registry is NOT MEASURED, and exits 2 rather than 1" \
  "ag err.json >/dev/null; [ \"\$?\" = 2 ]"
# The runner sets pipefail and this gate exits non-zero BY DESIGN, so `ag ... | grep` would return
# the GATE's status rather than the grep's - the row would fail with the output exactly right. The
# exit codes have their own rows above; these read the words.
check "and it says so in words that cannot be read as a security finding" \
  "{ ag err.json || true; } | grep -q 'AUDIT DID NOT RUN - THIS IS NOT A SECURITY RESULT'"
# AND IT MUST NOT PASS. An npm outage that turns green is a free ride past the gate, which is the
# false-green shape this tree keeps paying for.
check "an unreachable registry does NOT pass, because an outage is not a clean bill" \
  "! ag err.json >/dev/null"
check "a high or critical advisory FAILS with exit 1, and names itself a security result" \
  "ag bad.json >/dev/null; [ \"\$?\" = 1 ] && { ag bad.json || true; } | grep -q 'This IS a security result'"
check "a tree with only low and moderate advisories passes, which is the bar for a hot wallet" \
  "ag clean.json >/dev/null"
# THE DISCRIMINATOR IS STRUCTURAL. Matching '503' or 'endpoint returned an error' breaks the day npm
# rewords it, and npm has already reworded it once this year retiring the quick endpoint with a 400.
check "it discriminates on the JSON shape, not on npm's wording" \
  "grep -v '^[[:space:]]*#' '$AUDITGATE' | grep -q 'has(\"error\")' && ! grep -v '^[[:space:]]*#' '$AUDITGATE' | grep -qE \"'503'|endpoint returned an error\""

check "the build context leaves out the ops scripts, the harnesses, the tests and the docs" \
  "( for p in deploy scripts docs design .github '**/*.test.ts' '**/*.test.mjs'; do grep -qxF \"\$p\" '$REPO/.dockerignore' || exit 1; done )"
check "and the CI image job proves the runtime shape rather than assuming it" \
  "grep -q 'uid=1000 caps=0000000000000000 bnd=00000000000000c9 nnp=1 owner=1000' '$CIWF' && grep -q 'touch /home/node/probe' '$CIWF'"
check "and takes its run flags from the compose file, so the probe cannot supply what it asserts" \
  "grep -q 'docker compose -f deploy/z3/docker-compose.faucet.yml config --format json' '$CIWF' && grep -q 'docker run --rm \$flags -v r10:/app/data' '$CIWF' && ! grep -q 'docker run --rm --read-only' '$CIWF'"

echo "== repo: the cTAZ socket admits the app and not the box, and CI reads that from the unit"
# The app is uid 1000 since R-10, so root:root 0660 locks it out and 0666 lets in every uid
# on the host. root:1000 0660 is the one that admits the app alone, and the numbers here are
# measured rather than argued (review of #545: 0660 root:root is EACCES to uid 1000; 0666
# admits uid 1002 too; root:1000 0660 admits 1000 and refuses 1002).
#
# A unit file is the only place this can be declared, so this half IS a text check - but it
# is a text check on the ARTEFACT WE SHIP, not one standing in for behaviour. The behaviour
# half is the CI step, and the point of the last assertion is that the step reads the mode
# out of this unit instead of typing it, so the two cannot say different things.
SOCK="$REPO/deploy/z3/ctaz-rpc.socket"
check "the socket is owned by root and grouped to the app's gid, not to root" \
  "grep -qx 'SocketUser=root' '$SOCK' && grep -qx 'SocketGroup=1000' '$SOCK'"
check "and its mode is 0660, so it is not open to every uid on the box" \
  "grep -qx 'SocketMode=0660' '$SOCK' && ! grep -q '^SocketMode=0666' '$SOCK'"
check "and CI proves both uids against it, reading the mode from the unit rather than typing it" \
  "grep -q \"sed -n 's/^SocketMode=//p\" '$CIWF' && grep -q 'anyone else' '$CIWF' && grep -q 'expected EACCES' '$CIWF'"
# THE TWO HALVES ARE PINNED IN DIFFERENT PLACES AND SOMETHING HAS TO COMPARE THEM (SDE-App,
# review of #553). The unit names a NUMERIC gid; the entrypoint drops to `node` BY NAME. They
# agree at the pinned digest and the realistic way they stop agreeing is a base bump, which
# arrives as a dependabot PR whose reviewer has no reason to think about a socket unit. So the
# probe must ASK the image who node is rather than type 1000, and refuse when the unit
# disagrees with it.
check "and the probe derives the app's uid and gid from the image instead of typing them" \
  "grep -q 'imguid=\"\$(docker run --rm --entrypoint id' '$CIWF' && grep -q 'imggid=\"\$(docker run --rm --entrypoint id' '$CIWF' && ! grep -q 'as 1000' '$CIWF'"
check "and refuses when the unit's SocketGroup is not the image's node gid" \
  "grep -qF 'is not the image'\''s node gid' '$CIWF'"
check "and probes a THIRD time as the app, so a listener that died on the first connection is caught" \
  "grep -q 'the listener survived' '$CIWF' && grep -q 'the listener did not survive the first connection' '$CIWF'"

# THE DOC'S CLAIM ABOUT WHEN THIS SOCKET IS DIALLED, HELD TO THE CODE THAT DECIDES IT (CTO,
# review of #553). An earlier draft said the ACL was unobserved while cTAZ is parked, and
# that was backwards: the dial is gated on the app's FAUCET_CTAZ_ENABLED, not on the node's
# state, so the socket is opened every refresh tick today and a wrong ACL reads as the same
# `cannot-verify` a parked node produces. A doc that gets this backwards sends an operator
# away from a live fault, so both halves of the claim are pinned rather than trusted.
# COUNTED, NOT MERELY PRESENT (SDE-App, review of #553, after it merged). grep -qF needs one
# match and read.ts has TWO gates - readCtazNodeState's and readCtazRecency's. They renamed
# one, the reader began touching the transport with the flag off, and this check stayed green
# while the doc still said neither reader does. Two is the number the doc's claim rests on, so
# two is what the check demands.
check "OPERATIONS.md says the dial is gated on the app's flag, and BOTH readers still gate it there" \
  "grep -qF 'FAUCET_CTAZ_ENABLED' '$REPO/OPERATIONS.md' && grep -qF 'config.crosslink.enabled' '$REPO/OPERATIONS.md' && [ \"\$(grep -c 'if (!config.crosslink.enabled)' '$REPO/src/lib/crosslink/read.ts')\" = 2 ]"
# THE DOC'S ARITHMETIC, AND WHAT THIS ROW CAN AND CANNOT SEE (#564). Six connections a minute is
# three ticks times two RPCs a tick. This row used to claim it held "the two awaits the tick
# REACHES". It did not and could not: it is a grep, and a grep sees TEXT.
#
# The CTO red-team showed the gap with a mutant that keeps every string this row reads and makes
# the second call conditional:
#     const info = reading.state === "cannot-verify" ? { blocks: null, tip: null } : await readCtazInfo();
# In the state OPERATIONS.md is actually describing - node parked, every tick cannot-verify - that
# is ONE dial per tick and the doc is wrong, and this suite measured 253/0 with it in place.
#
# REACHABILITY IS NOW HELD WHERE IT CAN BE: readOrder.test.ts counts accepts on a real socket
# across one readCtazNodeState(), in the healthy state AND in the cannot-verify state. That mutant
# dies there, by name, alone. What is left here is the DOCUMENT's side of the claim - that the
# figure is written down and that there are still exactly two call sites to multiply - which is
# worth holding and is all a repo-level grep is entitled to say.
#
# COMMENTS STRIPPED BEFORE READING: `grep -qF 'await readCtazInfo()'` matched a commented-out
# occurrence, so commenting the call out and leaving the text kept this green (the issue's second
# shape). Same trap as the #607 reader finding "node syncing" twice in prose.
# The strip is inlined rather than held in a variable: a variable referenced only inside the
# check string is not a USE as far as shellcheck can see, and SC2034 is a warning, which is above
# this repo's CI floor. The path expands when the string is built, so it reads once here.
check "and OPERATIONS.md's six-a-minute figure still has two RPC call sites to multiply (reachability is readOrder.test.ts's)" \
  "grep -qF 'six times a' '$REPO/OPERATIONS.md' \
   && [ \"\$(grep -vE '^[[:space:]]*(//|\*|/\*)' '$REPO/src/lib/crosslink/read.ts' | grep -c 'await readCtazRecency(')\" -ge 1 ] \
   && [ \"\$(grep -vE '^[[:space:]]*(//|\*|/\*)' '$REPO/src/lib/crosslink/read.ts' | grep -c 'await readCtazInfo()')\" -ge 1 ] \
   && [ \"\$(grep -vE '^[[:space:]]*(//|\*|/\*)' '$REPO/src/lib/crosslink/read.ts' | grep -c 'ctazRpc(transport()')\" = 2 ]"
check "and its 20-second figure is the interval the refresher actually uses" \
  "grep -qF 'REFRESH_INTERVAL_MS' '$REPO/OPERATIONS.md' && grep -qE 'REFRESH_INTERVAL_MS = 20_000' '$REPO/src/lib/crosslink/cache.ts'"
check "and the socket probe reaps its listener and volume on EVERY exit path, not just the happy one" \
  "grep -qF \"trap 'docker rm -f ctaz-listener\" '$CIWF' && [ \"\$(grep -c 'docker volume rm ctazsock' '$CIWF')\" = 1 ]"

echo "== repo: the watchdog's node-lag limit is the miner's, for the miner's reason"
# Both read zebra's clock-based estimatedheight. The miner's guard (sync.rs) explains why
# 100 and not less: hour-long testnet gaps push the estimate ~50 "behind" with nobody
# ahead. The watchdog trips its heal on the same number and had 50 (risk register II,
# R-11). Held equal here rather than pinned to a literal, so a considered change to one
# is a considered change to both.
MINER_LAG="$(sed -nE 's/^pub const DEFAULT_MAX_LAG: u64 = ([0-9]+);$/\1/p' "$REPO/deploy/z3/miner/src/sync.rs")"
WD_LAG="$(sed -nE 's/^NODE_LAG_LIMIT="\$\{WATCHDOG_NODE_LAG_LIMIT:-([0-9]+)\}".*/\1/p' "$REPO/deploy/z3/watchdog.sh")"
check "both defaults could be read" "[ -n '$MINER_LAG' ] && [ -n '$WD_LAG' ]"
check "and the watchdog's default equals the miner's DEFAULT_MAX_LAG ($WD_LAG vs $MINER_LAG)" "[ '$WD_LAG' = '$MINER_LAG' ]"

CIWF_LIVE="$REPO/.github/workflows/live-smoke.yml"
echo "== repo: the docs do not claim a fork check the code does not have"
# #533 / R-20. ARCHITECTURE.md said "chain-identity and branch-id checks catch a forked or
# mis-upgraded chain rather than paying out on it". They never have: chainIdentityOracle.ts asks
# zallet for getblockchaininfo, zallet does not implement it, so ourBranchId() is null for ever and
# node.chain has read cannot-verify in production since the day it shipped.
#
# THE COUPLING, so the sentence cannot drift back: while the oracle still depends on that method,
# the doc must say the check is NOT wired. If someone wires it for real, this row goes red and the
# person doing it is told to update the claim in the same change - which is the only moment anyone
# will know it is safe to make it.
if grep -qF 'getblockchaininfo' "$REPO/src/lib/zcash/chainIdentityOracle.ts" 2>/dev/null; then
  check "while the branch-id oracle still asks zallet for a method it lacks, ARCHITECTURE says the check is not wired" \
    "grep -qF 'not wired' '$REPO/docs/ARCHITECTURE.md' && grep -qF 'ourBranchId' '$REPO/docs/ARCHITECTURE.md'"
  check "and it no longer claims those checks catch a forked chain" \
    "! grep -qF 'branch-id checks catch a forked' '$REPO/docs/ARCHITECTURE.md'"
else
  check "the branch-id oracle no longer depends on zallet getblockchaininfo, so the claim can be revisited" "true"
fi

# AND THE LIVE PROBE READS THE VERDICT FROM OUTSIDE THE BOX. Inside the box nothing is wrong when
# the fork check has never verified anything: every page is green and every drip is served, which
# is exactly why the row belongs off-box.
check "the live probe reads node.chain.state rather than trusting the status code" \
  "grep -qF 'node?.chain?.state' '$REPO/scripts/live-probe.mjs'"
check "and both the probe and the re-probe judge it by the SAME knob, or a re-probe would overturn the probe" \
  "[ \"\$(grep -c 'SMOKE_FORK_CHECK_ENFORCED' '$CIWF_LIVE')\" = 2 ]"

echo "== repo: the watchdog's CORROBORATED-lag limit stays clear of the app's agreement budget"
# A SECOND CROSS-FILE NUMBER, and it is a different relationship from the one above. The
# watchdog calls a corroborated tip a stall at NODE_CONFIRMED_LAG_LIMIT blocks; the APP calls
# two references `corroborated` when they are within TIP_AGREE_BLOCKS of each other. If the
# watchdog's number ever slid to or under the app's, the rung would declare a stall at a
# distance the app itself calls agreement - a heal fired inside the noise, which is how the
# first cut of this rung got its threshold wrong in the other direction.
# Held as an INEQUALITY, not two literals: the right relationship is "clear of it", and
# pinning them equal would forbid the very change that fixes a future miscalibration.
# THIS ROW USED TO COMPARE TWO LITERALS AND IT WENT BLIND (#651, found by SDE-App reviewing their
# own change against this file). After #651 the app's AGREE_BLOCKS only decides the FALLBACK path -
# the tolerance actually applied is computed from the observed block rate and PUBLISHED as
# `agreeBlocks`. So "25 > 20" kept passing while the relationship it protects had moved, and it
# would have kept passing at TIP_AGREE_SECONDS=100000. A check that cannot fail is not a check.
#
# WHAT IS HELD NOW: that the watchdog DERIVES its limit from the published field, with the constant
# as a floor. That is a property a mutant can break; the old inequality was not.
WD_CONF="$(sed -nE 's/^NODE_CONFIRMED_LAG_LIMIT="\$\{WATCHDOG_NODE_CONFIRMED_LAG_LIMIT:-([0-9]+)\}".*/\1/p' "$REPO/deploy/z3/watchdog.sh")"
check "the watchdog still declares a confirmed-lag floor" "[ -n '$WD_CONF' ]"
# grep -qF throughout: the shapes being matched contain $ and " and [0-9] classes, and an escaped
# regex through check()'s eval is how the first version of these rows aborted the whole suite.
# COMMENTS STRIPPED BEFORE READING, and SDE-UI caught this one: watchdog.sh:779 is a COMMENT
# containing "agreeBlocks", so a bare grep is satisfied by the prose explaining the derivation
# whether or not the derivation is there. They measured it - replacing the extraction with
# `agree_b=""` left this row GREEN. Same trap as the #607 reader finding "node syncing" twice in
# prose and the #640 row matching a commented-out call.
check "and it DERIVES the working limit from the app's published agreeBlocks rather than assuming a number" \
  "[ \"\$(grep -vE '^[[:space:]]*#' '$REPO/deploy/z3/watchdog.sh' | grep 'agree_b=' | grep -c 'agreeBlocks')\" -ge 1 ] && [ \"\$(grep -vE '^[[:space:]]*#' '$REPO/deploy/z3/watchdog.sh' | grep -c 'agree_b + 5')\" -ge 1 ]"
check "and the floor is still the fallback, so a body without the field keeps today's behaviour" \
  "grep -qF 'conf_limit=' '$REPO/deploy/z3/watchdog.sh' && grep -qF 'NODE_CONFIRMED_LAG_LIMIT' '$REPO/deploy/z3/watchdog.sh'"
# THE FLOOR IS A TIME NOW, in the unit the app's own agreement window is written in, so the
# relationship this block exists for can be held as the inequality it always was: the watchdog's
# floor in seconds must not sit under the app's AGREE_SECONDS, or the rung would call a stall at
# a distance the app calls agreement. Two literals in two files, compared - and a mutant that
# lowers one is what this row is for. The block constant stays as the fallback for a body with
# no rate, held by the row above.
WD_CONF_SECS="$(sed -nE 's/^NODE_CONFIRMED_LAG_SECS="\$\{WATCHDOG_NODE_CONFIRMED_LAG_SECS:-([0-9]+)\}".*/\1/p' "$REPO/deploy/z3/watchdog.sh")"
APP_AGREE_SECS="$(sed -nE 's/^export const AGREE_SECONDS = num\("TIP_AGREE_SECONDS", ([0-9]+)\);.*/\1/p' "$REPO/src/lib/zcash/externalTip.ts")"
check "the watchdog declares its confirmed-lag floor in SECONDS" "[ -n '$WD_CONF_SECS' ]"
check "and the app's agreement window was read, not assumed" "[ -n '$APP_AGREE_SECS' ]"
check "and the floor is at or above the app's agreement window ($WD_CONF_SECS s vs $APP_AGREE_SECS s)" \
  "[ -n '$WD_CONF_SECS' ] && [ -n '$APP_AGREE_SECS' ] && [ '$WD_CONF_SECS' -ge '$APP_AGREE_SECS' ]"
check "and the floor is converted at the app's PUBLISHED rate, read from the body and not assumed" \
  "[ \"\$(grep -vE '^[[:space:]]*#' '$REPO/deploy/z3/watchdog.sh' | grep 'spb=' | grep -c 'secondsPerBlock')\" -ge 1 ]"
check "and the stall comparison uses the derived limit rather than the constant" \
  "grep -qF -e '-gt \"\$conf_limit\"' '$REPO/deploy/z3/watchdog.sh' && ! grep -qF -e '-gt \"\$NODE_CONFIRMED_LAG_LIMIT\"' '$REPO/deploy/z3/watchdog.sh'"
# AND THE TWO RUNGS READ THE SAME GATE. Step 7 read `externalHeight` while step 8 read
# `corroborated`+`usedHeight`, which is the same height with the corroboration discarded, and
# one flaky source could buy a chain rewind. One definition now, called twice.
check "step 7 and step 8 both go through corroborated_tip_height, and nothing greps externalHeight" \
  "[ \"\$(grep -c 'corroborated_tip_height)\"' '$REPO/deploy/z3/watchdog.sh')\" = '2' ] && ! grep -q 'grep -o .\"externalHeight' '$REPO/deploy/z3/watchdog.sh'"

echo "== repo: the box's CI gate requires every job ci.yml defines, by name"
# auto-deploy.sh refuses a commit unless every job in its list completed green
# (risk register II, R-1). The list is a default in the script; ci.yml is where jobs
# are added and renamed. If they drift apart the gate is wrong in one of two ways:
# a job the list names that ci.yml no longer defines is "absent" for ever, and no
# commit ships; a job ci.yml added that the list does not name is never asked about,
# and a red one ships. Both are silent, so the two lists are held equal here.
# A job id may be [A-Za-z_][A-Za-z0-9_-]*; the first cut admitted lowercase only, so an
# extra_job: escaped the comparison and a red one would have shipped. A trailing comment
# on the job line is tolerated. And a job-level `name:` renames the check-run GitHub
# reports, so the gate would see the id as absent for ever: refused below by name.
CI_JOBS="$(awk '/^jobs:/{injobs=1; next} injobs && /^  [A-Za-z_][A-Za-z0-9_-]*:[[:space:]]*(#.*)?$/ {sub(/^  /, ""); sub(/:.*$/, ""); print}' "$REPO/.github/workflows/ci.yml" | sort | tr '\n' ' ')"
CI_JOB_NAMES="$(awk '/^jobs:/{injobs=1; next} injobs && /^    name:/ {print}' "$REPO/.github/workflows/ci.yml")"
check "no job in ci.yml sets a display name, which would rename its check-run away from its id" \
  "[ -z '$CI_JOB_NAMES' ] || { echo '   job-level name: lines:'; printf '%s\n' '$CI_JOB_NAMES'; false; }"
GATE_JOBS="$(sed -nE 's/^CI_REQUIRED="\$\{AUTODEPLOY_REQUIRED_CHECKS:-([^}]+)\}"$/\1/p' "$REPO/deploy/z3/auto-deploy.sh" | tr ' ' '\n' | sort | tr '\n' ' ')"
check "ci.yml defines jobs and the gate's default list could be read" "[ -n '$CI_JOBS' ] && [ -n '$GATE_JOBS' ]"
check "and the gate requires exactly the jobs ci.yml defines: '$GATE_JOBS' vs '$CI_JOBS'" \
  "[ '$GATE_JOBS' = '$CI_JOBS' ]"

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


echo "== repo: a box address cannot enter the tree, in any shape"
# Three times now. #95 took the IP out of an HTTPS.md A record, #250 out of ops examples and
# fixtures, #656 put root@<ip> back in two scripts a `git add -A` swept up. Twice removed by a
# reviewer remembering. That is a check's job, not a memory's.
#
# NOT "root@ next to an IPv4", which is the shape I was asked for and wrote first. Measured
# against all three instances: it catches #656 and MISSES #95 (`A faucet.example.org <ip>`) and
# #118 (`Host <ip> faucet.*`). The access verb is not the constant, the ADDRESS is - so a public
# IPv4 is refused unless it is named below with a reason. Examples belong in RFC 5737's
# documentation ranges, exempt by range; a real box comes from FAUCET_BOX (#658).
#
# The set is tracked AND untracked-not-ignored, because untracked-and-not-ignored is what #656
# was: one `git add -A` from being permanent. Deliberately-ignored local scratch stays invisible,
# which is #658's decision and not this row's to overturn.

# Public addresses this repo names on purpose. An entry here is a decision, in writing.
#   35.246.253.46                       a real peer in sync.rs's captured getpeerinfo body
#   70.34.* 45.76.30.90                 Crosslink's own seeds, quoted in a spike
#   203.0.114.1                         one OFF the doc range, proving subnetOf separates them
#   5.6.1.1                             a Zcash spec SECTION number that looks like an address
#   172.32.0.1 8.8.8.8                  externalTip's SSRF vectors
BOX_ADDR_ALLOW="35.246.253.46 70.34.201.202 45.76.30.90 70.34.201.146 70.34.209.22 70.34.195.191 70.34.209.18 203.0.114.1 5.6.1.1 172.32.0.1 8.8.8.8"

# Reads `path:line:text` on stdin, prints the lines carrying a public address. The 172 boundary
# is the one worth getting right: 172.16-31 is private, 172.235 is the box we keep deleting.
box_public_ips() {
  awk -v allow="$BOX_ADDR_ALLOW" '
    BEGIN { n = split(allow, a, " "); for (i = 1; i <= n; i++) named[a[i]] = 1 }
    function pub(ip,   p, k, i) {
      k = split(ip, p, ".")
      if (k != 4) return 0
      for (i = 1; i <= 4; i++) { if (p[i] !~ /^[0-9]+$/) return 0; if (p[i] + 0 > 255) return 0 }
      if (p[1]+0 == 0 || p[1]+0 == 10 || p[1]+0 == 127 || p[1]+0 >= 224) return 0
      if (p[1]+0 == 169 && p[2]+0 == 254) return 0
      if (p[1]+0 == 172 && p[2]+0 >= 16 && p[2]+0 <= 31) return 0
      if (p[1]+0 == 100 && p[2]+0 >= 64 && p[2]+0 <= 127) return 0
      if (p[1]+0 == 192 && p[2]+0 == 168) return 0
      if (p[1]+0 == 192 && p[2]+0 == 0 && p[3]+0 == 2) return 0
      if (p[1]+0 == 198 && p[2]+0 == 51 && p[3]+0 == 100) return 0
      if (p[1]+0 == 203 && p[2]+0 == 0 && p[3]+0 == 113) return 0
      return 1
    }
    { rest = $0
      while (match(rest, /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/)) {
        ip = substr(rest, RSTART, RLENGTH); rest = substr(rest, RSTART + RLENGTH)
        if (pub(ip) && !(ip in named)) { print; next }
      } }'
}

# A content matcher cannot scan its own test vectors: the controls below are real box-address
# lines, so this file trips its own gate. Counting them beats exempting the file - an exemption
# would make this the one place an address could be added unseen.
BOX_ADDR_SELF="deploy/z3/tests/suites/repo.sh"
BOX_ADDR_SCAN="$(cd "$REPO" && git grep --untracked -nIE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' -- . ":!$BOX_ADDR_SELF" 2>/dev/null || true)"
BOX_ADDR_OWN="$(cd "$REPO" && git grep --untracked -nIE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' -- "$BOX_ADDR_SELF" 2>/dev/null | box_public_ips | grep -c . || true)"
BOX_ADDR_FILES="$(cd "$REPO" && git ls-files --cached --others --exclude-standard 2>/dev/null | grep -c . || true)"
BOX_ADDR_LINES="$(printf '%s' "$BOX_ADDR_SCAN" | grep -c . || true)"
BOX_ADDR_HITS="$(printf '%s\n' "$BOX_ADDR_SCAN" | box_public_ips || true)"
BOX_ADDR_HIT_N="$(printf '%s' "$BOX_ADDR_HITS" | grep -c . || true)"

# The two floors first. `git grep` exits 128 in a tree with no index - which is what
# `git archive | tar -x` produces, and how the mutants for this very row get built - and an
# empty scan satisfies an absence assertion perfectly. Measured: exit 128, no output, row green.
# shellcheck disable=SC2034 # every BOX_ADDR_* below is read inside check's eval
check "the working tree could be enumerated at all, so an absent scan cannot read as a clean one" \
  "[ '$BOX_ADDR_FILES' -ge 200 ]"
check "and the scan actually read lines carrying an address-shaped string" \
  "[ '$BOX_ADDR_LINES' -ge 100 ]"
check "and NO file in it publishes a public IP address that is not named above" \
  "[ '$BOX_ADDR_HIT_N' -eq 0 ]"
[ "$BOX_ADDR_HIT_N" -eq 0 ] || printf '%s\n' "$BOX_ADDR_HITS" | sed 's/^/     box address: /'

# The controls, through the SAME function the gate uses. An absence assertion with nothing
# proving the looking works is the failure mode this suite keeps finding in other people's rows.
BOX_ADDR_POS="$(printf '%s\n' \
  'deploy/z3/HTTPS.md:15:A     faucet.example.org    172.235.26.235' \
  'OPERATIONS.md:212:Host 172.235.26.235 faucet.*' \
  'scripts/dev-pull-env.sh:15:BOX="${FAUCET_BOX:-root@172.235.26.235}"' \
  'docs/RUNBOOK.md:8:ssh -L 8081:127.0.0.1:8081 root@172.235.26.235' \
  'deploy/x.sh:3:scp deploy.tar root@45.32.11.9:/tmp/' \
  | box_public_ips | grep -c . || true)"
check "and the same matcher flags every shape this repo has ACTUALLY shipped an address in" \
  "[ '$BOX_ADDR_POS' -eq 5 ]"
BOX_ADDR_NEG="$(printf '%s\n' \
  'deploy/z3/OBSERVABILITY.md:37:ssh -L 8081:127.0.0.1:8081 root@<box>' \
  'deploy/z3/tests/suites/alerts.sh:207:http://rpcuser:hunter2@127.0.0.1:8232' \
  'deploy/z3/HTTPS.md:15:A     faucet.example.org    203.0.113.45' \
  'deploy/compose.yml:9:the docker bridge hands out 172.17.0.2' \
  'deploy/z3/miner/src/sync.rs:174:"addr": "35.246.253.46:49750"' \
  | box_public_ips | grep -c . || true)"
check "and passes loopback, private, documentation-range and named addresses, so it is not a blanket" \
  "[ '$BOX_ADDR_NEG' -eq 0 ]"

# An exemption for an address nobody uses any more is a blanket waiting for a collision.
BOX_ADDR_STALE=""
for _a in $BOX_ADDR_ALLOW; do
  (cd "$REPO" && git grep --untracked -qF "$_a" -- . 2>/dev/null) || BOX_ADDR_STALE="$BOX_ADDR_STALE $_a"
done
check "and every exempted address is still in the tree, so the list cannot grow into a blanket" \
  "[ -z '$BOX_ADDR_STALE' ]"
check "and this file carries exactly its five control fixtures and no sixth address" \
  "[ '$BOX_ADDR_OWN' -eq 5 ]"
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
#
# THE TOP-LEVEL BLOCK IS NOT THE WHOLE STORY (risk register II, R-8). A job-level
# `permissions:` overrides the top-level one, and `pull_request_target` runs the
# workflow with the BASE repository's token and secrets against the pull request's
# code. Mutation, before this: switch the trigger to pull_request_target and give the
# app job `contents: write` plus `id-token: write`, and this block stayed green. Both
# are refused now, and `.yaml` is covered, since a new workflow under that extension
# would have escaped every check here.
for wf in "$REPO"/.github/workflows/*.yml "$REPO"/.github/workflows/*.yaml; do
  [ -f "$wf" ] || continue
  name="$(basename "$wf")"
  check "$name declares a permissions block" "grep -q '^permissions:' '$wf'"
  check "$name grants contents no more than read" "grep -A 4 '^permissions:' '$wf' | grep -q 'contents: read'"
  check "$name grants nothing write at the top level" "! grep -A 6 '^permissions:' '$wf' | grep -qE ': *write'"
  # Any job-level block, the empty map included: one place to reason about the token.
  check "$name has no job-level permissions block (the top-level one is the only grant)" "! grep -qE '^ +permissions:' '$wf'"
  # The WORD, anywhere outside a comment: `on: pull_request_target`, `on: [push,
  # pull_request_target]`, a block key and a list item all parse to the trigger, and the
  # first version matched only the last two (review of #534).
  # COUNTED, NOT -q: under pipefail a `sed | grep -q` that matches early returns sed's
  # SIGPIPE status, and `!` turned that into a pass on the exact file it should have
  # refused (measured: `on: pull_request_target` read green). -c drains the stream.
  check "$name never runs on pull_request_target" \
    "[ \"\$(sed 's/#.*//' '$wf' | grep -cE '(^|[^A-Za-z_])pull_request_target([^A-Za-z_]|$)')\" = 0 ]"
  # EVERY ACTION IS PINNED TO A COMMIT, not a tag. A tag can be moved by whoever holds
  # the action's repository; a SHA cannot. dependabot's github-actions ecosystem keeps
  # the SHA current and rewrites the trailing version comment; the comment's presence is
  # required here and its value trusted, since the suite cannot resolve a SHA offline.
  # THE COMPLEMENT, not an enumeration: every line carrying `uses:` outside a comment
  # must be the pinned form, so a spelling the enumerator did not foresee (`-   uses:`,
  # a flow mapping) is refused rather than skipped (review of #534).
  check "$name pins every uses: to a 40-hex commit with the version beside it" \
    "[ \"\$(grep -E 'uses:' '$wf' | grep -vE '^ *#' | grep -vcE '^ *(- *)?uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_./-]+)?@[0-9a-f]{40} # v[0-9]')\" = 0 ]"
done

echo "== repo: /api/ready's key ORDER is load-bearing, in two readers (risk register #19)"
# faucet-metrics.sh reads `ready` as the body's FIRST key (a presence test is satisfied by
# a foreign body's nested node.ready) and `ts` as its LAST (a truncation loses the tail).
# Both are properties of one object literal in the route, and a reorder there would break
# a monitor silently - the shape this repo has a name for.
RR="$REPO/src/app/api/ready/route.ts"
# Both spellings: `ready,` is a shorthand property and `ts: ...` is not, and the first
# version of this only matched the colon form - which found `backend` first and `ts` last
# and would have passed a reorder of the two keys that matter.
ready_keys="$(sed -n '/NextResponse.json(/,/status: ready ? 200 : 503/p' "$RR" \
  | grep -oE '^      [a-zA-Z_][a-zA-Z0-9_]*[,:]' | sed 's/[ ,:]//g')"
check "the readiness body's first key is ready" \
  "[ \"\$(printf '%s\n' \"$ready_keys\" | head -n1)\" = ready ]"
check "and its last is ts, which is what tells a truncated body from a whole one" \
  "[ \"\$(printf '%s\n' \"$ready_keys\" | tail -n1)\" = ts ]"
check "and the metrics script says it depends on both, so the coupling is not a surprise" \
  "grep -q 'has to be the body.s FIRST key' '$REPO/deploy/z3/faucet-metrics.sh'"

echo "== repo: every image this REPO declares is watched, and the rest are named (register #26)"
# npm, cargo and the actions were covered. The IMAGES the faucet runs as - node:22-slim
# under the app, caddy:2 terminating TLS - were not, so a CVE in either arrived only if
# somebody happened to read a release note. Adding entries is easy; the hard parts are
# that the ENTRY IS OF THE RIGHT KIND (`docker` reads Dockerfiles, Compose needs
# `docker-compose`, and the wrong one parses nothing and says nothing) and that the list
# keeps up with a tree that grows image references.
DB="$REPO/.github/dependabot.yml"
mk_scratch "${TMPDIR:-/tmp}/repo-dependabot.XXXXXX"

# Pair every entry with its ecosystem by walking the updates list, rather than grepping
# `directory:` anywhere in the file: npm and github-actions both carry `directory: /`, so a
# bare grep was satisfied by them and passed with the docker entry deleted outright.
# A function, so the same scan can be run against a FIXTURE tree below: a check on the
# real tree proves it is quiet on a good tree, and only a planted defect proves it speaks.
scan_images() { # $1 dependabot.yml  $2 repo root  $3 report file
python3 - "$1" "$2" "$3" <<'PY'
import os, re, sys
db, repo, out = sys.argv[1], sys.argv[2], sys.argv[3]

# Plain-text parse: the harness image has no PyYAML, and this file's shape is fixed.
entries, eco, directory = [], None, None
for line in open(db):
    if re.match(r"^\s*-\s*package-ecosystem:", line):
        if eco:
            entries.append((eco, directory))
        eco = line.split(":", 1)[1].strip().strip('"\'')
        directory = None
    elif eco and re.match(r"^\s+directory:", line):
        directory = line.split(":", 1)[1].strip().strip('"\'')
if eco:
    entries.append((eco, directory))

# What dependabot's own fetchers match: docker/lib/dependabot/docker/file_fetcher.rb uses
# /dockerfile|containerfile/i, and the compose fetcher uses the filename regex below.
dockerish = re.compile(r"dockerfile|containerfile", re.I)
composeish = re.compile(r"^(docker-)?compose(-[\w]+)?(\.[\w-]+)?\.ya?ml$", re.I)

# docker/lib/dependabot/docker/file_parser.rb FROM_LINE, ported piece by piece from the
# Ruby (shared_file_parser.rb holds the image pieces). `^` with no leading whitespace and
# /FROM/i are dependabot's choices, not ours; an indented FROM is invisible to it.
_DOMAIN_COMPONENT = r"(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])"
_DOMAIN = rf"(?:{_DOMAIN_COMPONENT}(?:\.{_DOMAIN_COMPONENT})+)"
_REGISTRY = rf"(?P<registry>{_DOMAIN}(?::\d+)?)"
_NAME_COMPONENT = r"(?:[a-z\d]+(?:(?:[._]|__|[-]*)[a-z\d]+)*)"
_IMAGE = rf"(?P<image>{_NAME_COMPONENT}(?:/{_NAME_COMPONENT})*)"
_TAG = r"(?::(?P<tag>[\w][\w.-]{0,127}))"
_DIGEST = r"(?:@sha256:(?P<digest>[0-9a-f]{64}))"
_NAME = r"(?:\s+AS\s+(?P<name>[\w-]+))"
FROM_LINE = re.compile(
    rf"^(?i:FROM)\s+(?:--platform=(?P<platform>\S+)\s+)?(?:{_REGISTRY}/)?{_IMAGE}{_TAG}?{_DIGEST}?{_NAME}?",
    re.ASCII)

want = {}   # directory -> set of required ecosystems
scanned = 0
for root, dirs, files in os.walk(repo):
    dirs[:] = [d for d in dirs if d not in (".git", "node_modules", ".next", ".claude", "coverage")]
    for f in files:
        rel = os.path.relpath(root, repo)
        d = "/" if rel == "." else "/" + rel
        if dockerish.search(f):
            scanned += 1
            want.setdefault(d, set()).add("docker")
        elif composeish.match(f):
            # Only if it actually names an image; a compose file with none is nothing to watch.
            try:
                body = open(os.path.join(root, f), encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            if re.search(r"^\s+image:", body, re.M):
                scanned += 1
                want.setdefault(d, set()).add("docker-compose")

have = {}
for e, d in entries:
    have.setdefault(d, set()).add(e)

# DELIBERATELY UNWATCHED, and it has to be said in the config or it is not deliberate.
# dependabot's Dockerfile parser has no ARG handling, so `FROM ${RUST_IMAGE}` yields no
# dependencies and an entry there would sit silent; the file's own note says the Rust
# version is not pinned by that line anyway, and nothing from that image ships.
EXEMPT = {"/deploy/z3/ctaz-build"}
config_text = open(db, encoding="utf-8").read()

missing = []
for d in sorted(EXEMPT):
    if d.lstrip("/") not in config_text:
        missing.append(f"{d} is exempt in the test but unexplained in dependabot.yml")
    # AND THE REASON HAS TO STILL HOLD. Naming the path in a comment is satisfied by any
    # mention at all, including one left behind after the cause was fixed - an exemption
    # that outlives its reason is an unwatched directory with paperwork. The reason here
    # is specific and checkable: dependabot's Dockerfile parser has no ARG handling, so a
    # FROM that interpolates a variable yields it no dependencies. If someone inlines that
    # tag, the exemption stops being true and this says so.
    dockerfile = os.path.join(repo, d.lstrip("/"), "Dockerfile")
    try:
        lines = list(open(dockerfile, encoding="utf-8"))
    except OSError:
        missing.append(f"{d} is exempt but has no Dockerfile to be exempt about")
        continue
    # THE WAY DEPENDABOT READS IT, not the way a person writes it. A dependency exists
    # when FROM_LINE matches AND a tag or digest was captured; nothing else. Two cuts of
    # this check approximated that and were wrong in both directions: uppercase-only
    # `FROM ` and "any $ on the line" let `from rust:1.90` and `--platform=$BUILDPLATFORM
    # rust:1.90` through (#482); then "any $ in the ref" was quiet on `rust:1.90-${V}`,
    # which dependabot DOES watch (tag `1.90-`, the regex is not end-anchored), and red
    # on `FROM build AS test`, which it does not (no tag). So the regex is ported rather
    # than paraphrased; the fixture plants below hold it to dependabot's answers.
    resolvable = [l.strip() for l in lines
                  if (m := FROM_LINE.match(l)) and (m["tag"] or m["digest"])]
    if resolvable:
        missing.append(
            f"{d} is exempt because dependabot cannot resolve its FROM, but "
            f"{resolvable[0]!r} is resolvable now - either watch it or update the reason")
for d, ecos in sorted(want.items()):
    if d in EXEMPT:
        continue
    for e in sorted(ecos):
        if e not in have.get(d, set()):
            missing.append(f"{d} needs a {e} entry")

# AND IT HAS TO PARSE. A malformed dependabot.yml does not fail a build: GitHub stops
# opening pull requests and says so only on a settings page nobody visits, which is the
# same no-signal shape this whole entry exists to remove. PyYAML is not in the harness
# image, so this asserts the shape the plain-text parser above depends on rather than
# validating YAML in general: every entry names an ecosystem AND a directory.
for e, d in entries:
    if not e:
        missing.append("an updates entry has no package-ecosystem")
    if not d:
        missing.append(f"the {e} entry names no directory")
if not entries:
    missing.append("dependabot.yml holds no updates entries at all")

with open(out, "w") as fh:
    fh.write(f"SCANNED={scanned}\n")
    fh.write("MISSING=" + ("; ".join(missing) if missing else "") + "\n")
    fh.write("ENTRIES=" + ",".join(f"{e}:{d}" for e, d in entries) + "\n")
PY
}
scan_images "$DB" "$REPO" "$T/report.txt"; scan_rc=$?
check "the scan ran to completion, rather than leaving a report to be misread" "[ $scan_rc -eq 0 ]"
SCANNED="$(sed -n 's/^SCANNED=//p' "$T/report.txt")"
# shellcheck disable=SC2034  # read inside the eval'd check string below, not here
MISSING="$(sed -n 's/^MISSING=//p' "$T/report.txt")"
# ITERATION CONTROL, the rule this file states 30 lines up: a scan that found nothing
# would report healthy. Three image-bearing files exist today; fewer means the walk broke.
check "the scan actually found image files, rather than reporting healthy on nothing" \
  "[ \"$SCANNED\" -ge 3 ]"
# THE TWO NOTHING CAN WATCH, held to a list so a THIRD cannot join them quietly. zebra and
# zallet are pinned in stack-versions.env, a shell env file no dependabot ecosystem parses,
# so they move only when a person moves them. "Every image this box runs is watched" was
# therefore false while they existed, and a false claim in a header is worse than none: it
# is what stops the next person looking. The claim is scoped to what this repo DECLARES,
# and the exceptions are enumerated here, where a new one reds the suite.
SV="$REPO/deploy/z3/stack-versions.env"
extra_unwatched=""
# deploy.sh SOURCES this file, so `export Z3_ZAINO_IMAGE=...` or an indented line pins an
# image the box will run just as surely as a bare one - and the bare-anchored grep did not
# see either. The realistic edit, uncommenting the existing line, was caught; these two
# were not (#482).
# ONE function for the pin and for the checks on it. The first cut gave the checks their
# own copy of the regex, so reverting the pin to the bare-anchored grep left them green.
pins_in() { grep -oE '^\s*(export\s+)?Z3_[A-Z_]*IMAGE' | sed -E 's/^\s*(export\s+)?//'; }
for img in $(pins_in < "$SV" 2>/dev/null | sort -u); do
  case "$img" in
    Z3_ZEBRA_IMAGE|Z3_ZALLET_IMAGE) ;;
    *) extra_unwatched="$extra_unwatched $img" ;;
  esac
done
check "the hand-updated images are still exactly zebra and zallet, and no others" \
  "[ -z '$extra_unwatched' ]"
# The pin has to see the spellings deploy.sh sees. It SOURCES stack-versions.env, so an
# exported or indented assignment pins an image just as a bare one does.
check "an 'export Z3_ZAINO_IMAGE=...' line would be seen by the pin" \
  "[ \"\$(printf '%s\\n' 'export Z3_ZAINO_IMAGE=x' | pins_in)\" = Z3_ZAINO_IMAGE ]"
check "and so would an indented one" \
  "[ \"\$(printf '%s\\n' '  Z3_ZAINO_IMAGE=x' | pins_in)\" = Z3_ZAINO_IMAGE ]"
check "and stack-versions.env says plainly that nothing automated watches them" \
  "grep -qi 'no dependabot ecosystem\|nothing automated watches' '$SV'"
# A tag can be re-pushed; a digest cannot. Both pins carry one, full length, because the
# pin file spent a fortnight naming versions the box did not run and the digest is the half
# the audit compares. A bare tag here would pass the rows above and pin nothing.
UNPINNED_DIGEST=""
for img in $(pins_in < "$SV" 2>/dev/null | sort -u); do
  case "$img" in Z3_ZAINO_IMAGE) continue ;; esac   # optional and shipped commented out
  grep -E "^\s*(export\s+)?$img=[^@]+@sha256:[0-9a-f]{64}\s*$" "$SV" >/dev/null || UNPINNED_DIGEST="$UNPINNED_DIGEST $img"
done
check "and every hand-updated image is pinned tag@sha256 with a full 64-hex digest:$UNPINNED_DIGEST" \
  "[ -z '$UNPINNED_DIGEST' ]"

# \$MISSING is expanded when `check` evals the string, not here: the message now carries
# whatever the Dockerfile said, and `${VARIANT}` interpolated at definition time was an
# unbound variable under set -u that aborted the run with no summary line. Expanded inside
# the eval it is data, and a `$(...)` in a FROM line is printed rather than run.
check "every directory holding an image has an entry OF THE RIGHT KIND" \
  "[ -z \"\$MISSING\" ] || { echo \"missing: \$MISSING\"; false; }"
# The two that matter, by name, so deleting either is a named failure rather than an
# arithmetic one.
check "the app's own base image is watched by a docker entry at the root" \
  "grep -q '^ENTRIES=.*docker:/,' '$T/report.txt' || grep -q '^ENTRIES=.*docker:/$' '$T/report.txt'"
check "and caddy by a docker-compose entry, because docker does not read compose files" \
  "grep -q 'docker-compose:/deploy/z3' '$T/report.txt'"

# THE EXEMPTION HAS TO FAIL WHEN ITS REASON FAILS, and only a planted Dockerfile proves
# that. The reason is "dependabot cannot resolve this FROM"; three spellings make it
# resolvable, and the first cut of the check saw only the first. Each is planted in a
# fixture copy of the image-bearing files, the same scan runs, and MISSING must name the
# directory. A check that is quiet on the real tree has only proved it can be quiet.
fx="$T/imgfix"; rm -rf "$fx"; mkdir -p "$fx/deploy/z3/ctaz-build" "$fx/.github"
cp "$DB" "$fx/.github/dependabot.yml"; cp "$REPO/Dockerfile" "$fx/Dockerfile"
cp "$REPO/deploy/z3/docker-compose.faucet.yml" "$fx/deploy/z3/"
# The first FROM is replaced, whatever it says, so a legitimate edit to that line does not
# read as "fixture did not take" three times over. The report is removed before each scan
# and the scan's exit status is honoured: a scanner that died used to leave the previous
# plant's MISSING line in place, and the next plant passed on it.
plant_from() { # $1 the FROM line to plant; the rest of the file is the real one
  PLANT="$1" awk '!done && /^FROM /{print ENVIRON["PLANT"]; done=1; next}{print}' \
    "$REPO/deploy/z3/ctaz-build/Dockerfile" > "$fx/deploy/z3/ctaz-build/Dockerfile"
  grep -qxF "$1" "$fx/deploy/z3/ctaz-build/Dockerfile" || { echo "fixture did not take: $1"; return 1; }
  rm -f "$T/imgfix.txt"
  scan_images "$fx/.github/dependabot.yml" "$fx" "$T/imgfix.txt" || { echo "scan failed on plant: $1"; return 1; }
  grep -q '^MISSING=.*ctaz-build.*resolvable now' "$T/imgfix.txt"
}
# And the opposite: a plant dependabot yields NOTHING for must stay quiet. Without this
# half the port could match every line and pass the three above.
quiet_on() {
  PLANT="$1" awk '!done && /^FROM /{print ENVIRON["PLANT"]; done=1; next}{print}' \
    "$REPO/deploy/z3/ctaz-build/Dockerfile" > "$fx/deploy/z3/ctaz-build/Dockerfile"
  grep -qxF "$1" "$fx/deploy/z3/ctaz-build/Dockerfile" || { echo "fixture did not take: $1"; return 1; }
  rm -f "$T/imgfix.txt"
  scan_images "$fx/.github/dependabot.yml" "$fx" "$T/imgfix.txt" || { echo "scan failed on plant: $1"; return 1; }
  grep -q '^MISSING=$' "$T/imgfix.txt"
}
check "the exemption is earned: the real ctaz FROM still interpolates a variable" \
  "grep -qE '^FROM \\\$\\{[A-Z_]+\\}' '$REPO/deploy/z3/ctaz-build/Dockerfile'"
check "an inlined tag makes the exemption FALSE, and the scan says so" \
  "plant_from 'FROM rust:1.90-bookworm AS build'"
check "so does a lowercase 'from', which dependabot reads and the first cut did not" \
  "plant_from 'from rust:1.90-bookworm AS build'"
check "and so does --platform=\$BUILDPLATFORM, which dependabot strips before it reads the image" \
  "plant_from 'FROM --platform=\$BUILDPLATFORM rust:1.90-bookworm AS build'"
check "and a variable in the SUFFIX of a tag: dependabot's regex stops at the \$ and keeps 'rust:1.90-'" \
  "plant_from 'FROM rust:1.90-\${VARIANT} AS build'"
check "a stage reference is NOT a dependency (no tag), and the scan stays quiet on it" \
  "quiet_on 'FROM build AS test'"
check "nor is an untagged image, which dependabot skips for want of a version" \
  "quiet_on 'FROM rust AS build'"
check "nor an indented FROM, which dependabot's ^FROM never sees" \
  "quiet_on '  FROM rust:1.90-bookworm AS build'"
rm -rf "$fx"

echo "== repo: the harness cannot keep a list that disagrees with the tree (risk register #29)"
# Two lists in run-tests.sh have to match something outside themselves, and both have
# failed at it: the default suite order against the files on disk, and the printed
# `apt-get install` against suite_deps (it missed `git`, then `jq` - each time an operator
# copy-pasted our own remedy and was refused again). The order is still written out
# because it is load-bearing; the install line is generated. These check the seams.
RT="$REPO/deploy/z3/tests/run-tests.sh"
mk_scratch "${TMPDIR:-/tmp}/repo-runtests.XXXXXX"

# THE REFUSAL, RUN FOR REAL: a suite file the default order does not name.
cp -r "$REPO/deploy/z3/tests" "$T/tests"
printf '# shellcheck shell=bash\ncheck "never runs" "true"\n' > "$T/tests/suites/zzznew.sh"
# `env -u SUITES`: this suite runs with SUITES set, and the guard only applies to the
# DEFAULT set - inherited, the inner run would skip the guard and recurse into itself.
( cd "$REPO" && env -u SUITES TEST_SCRATCH="$T/tests" bash "$T/tests/run-tests.sh" > "$T/unlisted.log" 2>&1 )
rc=$?
check "a suite file the default order does not name REFUSES the run" "[ $rc -eq 2 ]"
check "and says which file would never have run" "grep -q 'on disk but never run: zzznew' '$T/unlisted.log'"
check "rather than a green tally that silently skipped it" "! grep -q 'passed,' '$T/unlisted.log'"
rm -f "$T/tests/suites/zzznew.sh"
# And the other direction: a name in the order with no file behind it.
sed -i.bak 's/^SUITE_ORDER="zsnap/SUITE_ORDER="ghostsuite zsnap/' "$T/tests/run-tests.sh"
( cd "$REPO" && env -u SUITES TEST_SCRATCH="$T/tests" bash "$T/tests/run-tests.sh" > "$T/ghost.log" 2>&1 )
rc=$?
check "a name in the order with no file REFUSES too" "[ $rc -eq 2 ] && grep -q 'no file: ghostsuite' '$T/ghost.log'"
# A DUPLICATE is neither of those: set membership passes, the suite is sourced twice, the
# tally is inflated, and the second sourcing inherits the first one's leftovers.
sed -i.bak 's/^SUITE_ORDER="ghostsuite zsnap/SUITE_ORDER="zsnap zsnap/' "$T/tests/run-tests.sh"
( cd "$REPO" && env -u SUITES TEST_SCRATCH="$T/tests" bash "$T/tests/run-tests.sh" > "$T/dupe.log" 2>&1 )
rc=$?
check "a suite named twice REFUSES rather than running twice and counting twice" \
  "[ $rc -eq 2 ] && grep -q 'named more than once' '$T/dupe.log'"
# A selection that names nothing sourced no suite and exited 0 - a green run of nothing.
( cd "$REPO" && SUITES=" " bash "$RT" > "$T/blank.log" 2>&1 )
rc=$?
check "SUITES that names no suite REFUSES rather than passing having run nothing" \
  "[ $rc -eq 2 ] && grep -q 'names no suite' '$T/blank.log'"

# A BROKEN SYMLINK IS A SUITE THAT CAN NEVER RUN. `[ -e ]` is false for one, so the
# comparison above simply did not see it: a .sh-named entry in suites/, never run, never
# mentioned, green tally - the exact shape the guard exists to refuse, arriving through
# the one door it was not watching.
cp -r "$REPO/deploy/z3/tests" "$T/tests2"
ln -sf /nonexistent/nope "$T/tests2/suites/zzzbroken.sh"
( cd "$REPO" && env -u SUITES TEST_SCRATCH="$T/tests2" bash "$T/tests2/run-tests.sh" > "$T/broken.log" 2>&1 )
rc=$?
# Both halves in one check, because exit 2 is this harness's refusal code generally: with
# the guard removed the run still exited 2 for an unrelated reason and a bare rc test
# passed on it. A refusal has to be THIS refusal.
check "a broken symlink in suites/ REFUSES the run, and says which file" \
  "[ $rc -eq 2 ] && grep -q 'broken symlink:.*zzzbroken' '$T/broken.log'"
rm -f "$T/tests2/suites/zzzbroken.sh"

# A LISTED SUITE THAT DOES NOT SOURCE IS A SUITE THAT DID NOT RUN. Without the floor a
# parse error left the loop moving on: measured, 23 passed / 0 failed and exit 0 where
# sixty checks were due. Same sentence as the guard above, one door over.
printf '# shellcheck shell=bash\ncheck "counts once" "true"\nif true; then\n' > "$T/tests2/suites/prune.sh"
( cd "$REPO" && SUITES="prune" TEST_SCRATCH="$T/tests2" bash "$T/tests2/run-tests.sh" > "$T/nosource.log" 2>&1 )
rc=$?
check "a suite that does not PARSE fails the run rather than passing it" "[ $rc -ne 0 ]"
check "and says which suite, and quotes the parse error" \
  "grep -q 'suite prune does not parse' '$T/nosource.log' && grep -q 'syntax error' '$T/nosource.log'"
# AND A SUITE WHOSE LAST COMMAND FAILS IS NOT A BROKEN SUITE. The first cut of the floor
# read the exit status of `.`, which is the exit status of the suite's last line, and
# ctazbroker.sh ends with `wait` on a process it just killed (143). It failed a suite
# whose every check had passed. The parse check cannot make that mistake, and this pins
# that a healthy suite ending in a non-zero command is left alone.
printf '# shellcheck shell=bash\ncheck "one real check" "true"\nfalse\n' > "$T/tests2/suites/prune.sh"
( cd "$REPO" && SUITES="prune" TEST_SCRATCH="$T/tests2" bash "$T/tests2/run-tests.sh" > "$T/lastfalse.log" 2>&1 )
rc=$?
check "a suite whose LAST command exits non-zero is not reported as broken" \
  "[ $rc -eq 0 ] && grep -q '1 passed, 0 failed' '$T/lastfalse.log'"
# And a suite that sources fine but asserts nothing is not a pass either.
printf '# shellcheck shell=bash\n: nothing to see here\n' > "$T/tests2/suites/prune.sh"
( cd "$REPO" && SUITES="prune" TEST_SCRATCH="$T/tests2" bash "$T/tests2/run-tests.sh" > "$T/nochecks.log" 2>&1 )
rc=$?
check "a suite that runs NO checks fails the run rather than reporting a clean zero" "[ $rc -ne 0 ]"
check "and says so in those terms" "grep -q 'ran no checks at all' '$T/nochecks.log'"
# #519: the snapshot the guard compares against was a plain `before`, and the autodeploy
# suite assigns `before=<sha>` for its own purposes. `[ ... -eq <sha> ]` errored, the if
# was false, and a suite that ran nothing passed. A suite that clobbers the counter is a
# failure in its own words, and one that only uses `before` is left alone.
printf '# shellcheck shell=bash\nharness_checks_before=deadbeef\n' > "$T/tests2/suites/prune.sh"
( cd "$REPO" && SUITES="prune" TEST_SCRATCH="$T/tests2" bash "$T/tests2/run-tests.sh" > "$T/clobber.log" 2>&1 )
rc=$?
check "a suite that overwrites the harness's counter fails the run" "[ $rc -ne 0 ]"
check "and says which variable, not 'integer expression expected'" \
  "grep -q 'overwrote the harness.s check counter' '$T/clobber.log' && ! grep -q 'integer expression expected' '$T/clobber.log'"
printf '# shellcheck shell=bash\nunset harness_checks_before\n' > "$T/tests2/suites/prune.sh"
( cd "$REPO" && SUITES="prune" TEST_SCRATCH="$T/tests2" bash "$T/tests2/run-tests.sh" > "$T/unset.log" 2>&1 )
rc=$?
check "a suite that unsets the counter is named, not an unbound-variable abort with no tally" \
  "[ $rc -ne 0 ] && grep -q 'overwrote the harness.s check counter' '$T/unset.log' && grep -q 'passed, .* failed' '$T/unset.log' && ! grep -q 'unbound variable' '$T/unset.log'"
printf '# shellcheck shell=bash\nbefore=deadbeef\n' > "$T/tests2/suites/prune.sh"
( cd "$REPO" && SUITES="prune" TEST_SCRATCH="$T/tests2" bash "$T/tests2/run-tests.sh" > "$T/before.log" 2>&1 )
rc=$?
check "a suite that sets a plain \`before\` and runs no checks is still caught" \
  "[ $rc -ne 0 ] && grep -q 'ran no checks at all' '$T/before.log' && ! grep -q 'integer expression expected' '$T/before.log'"
rm -rf "$T/tests2"

# THE INSTALL LINE IS GENERATED, so it cannot omit a command the guard demands. The three
# functions are sourced out of the shipped script rather than re-implemented here.
sed -n '/^suite_deps() {/,/^}/p; /^suite_caps() {/,/^}/p; /^dep_package() {/,/^}/p' "$RT" > "$T/fns.sh"
ORDER="$(grep -oE '^SUITE_ORDER="[^"]*"' "$RT" | sed 's/^SUITE_ORDER="//; s/"$//')"
GEN="$(
  # shellcheck disable=SC1090
  . "$T/fns.sh"
  P=""
  for s in $ORDER; do
    for c in $(suite_deps "$s") $(suite_caps "$s"); do
      p="$(dep_package "$c")"
      [ "$p" = "-" ] && continue
      [ -n "$p" ] || { echo "UNMAPPED:$c"; continue; }
      case " $P " in *" $p "*) ;; *) P="$P $p" ;; esac
    done
  done
  printf '%s' "${P# }"
)"
check "the package list was actually generated, not empty" "[ -n '$GEN' ]"
check "every command any suite declares has a package behind it" \
  "case '$GEN' in *UNMAPPED*) false ;; *) true ;; esac"
# THE CAPS REFUSAL PRINTS ITS OWN RECIPE, and nothing read it: the grep below resolves to
# the header COMMENT, and the check further down reads only the DEPS refusal. That is the
# recipe a macOS operator pastes - the population that hit both earlier misses - and it
# could be hardcoded with every check green. Force it by shimming a GNU-only behaviour.
mkdir -p "$T/nostat"
for b in bash sh env dirname basename sed grep awk tr cut head tail sort uniq cat ls mkdir rm cp mv chmod printf date find sha256sum seq id tee wc readlink xargs zstd curl gpg python3 git jq; do
  src="$(command -v "$b" 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$T/nostat/$b"
done
printf '#!/usr/bin/env bash\ncase " $* " in *" -c "*) exit 1 ;; esac\nexec /usr/bin/stat "$@"\n' > "$T/nostat/stat"
chmod +x "$T/nostat/stat"
( cd "$REPO" && env -u SUITES PATH="$T/nostat" bash "$RT" > "$T/caps.log" 2>&1 )
rc=$?
check "a missing GNU behaviour refuses, so the caps recipe is reachable" \
  "[ $rc -eq 2 ] && grep -q 'stat -c' '$T/caps.log'"
caps_printed="$(grep -oE 'apt-get install -y -qq [a-zA-Z0-9 ._+-]+' "$T/caps.log" | head -n1 | sed 's/apt-get install -y -qq //')"
caps_sorted="$(printf '%s\n' $caps_printed | sort | tr '\n' ' ')"

# The header comment is prose an operator copy-pastes and cannot be generated, so it is
# compared. Sorted: the order in a comment is not the thing under test.
HDR="$(grep -oE 'apt-get install -y -qq .*' "$RT" | head -n1 | sed 's/apt-get install -y -qq //')"
hdr_sorted="$(printf '%s\n' $HDR | sort | tr '\n' ' ')"
gen_sorted="$(printf '%s\n' $GEN | sort | tr '\n' ' ')"
check "the recipe in the header comment names exactly the generated package set" \
  "[ '$hdr_sorted' = '$gen_sorted' ]"

# AND THE LINE IT ACTUALLY PRINTS, by making it refuse. Comparing only the header comment
# left the printed remedy free to be hardcoded again, which is the whole defect.
mkdir -p "$T/nojq"
for b in bash sh env dirname basename sed grep awk tr cut head tail sort uniq cat ls mkdir rm cp mv chmod printf date find stat sha256sum seq id whoami tee wc dd du df sleep touch readlink realpath xargs zstd curl gpg python3 git; do
  src="$(command -v "$b" 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$T/nojq/$b"
done
( cd "$REPO" && env -u SUITES PATH="$T/nojq" bash "$RT" > "$T/norecipe.log" 2>&1 )
rc=$?
check "a missing command still refuses, so the printed remedy is reachable" "[ $rc -eq 2 ]"
# The charset takes a package with a dot, a plus or a capital (python3.12, g++): a
# narrower one truncates silently and the comparison fails for the wrong reason.
printed="$(grep -oE 'apt-get install -y [a-zA-Z0-9 ._+-]+' "$T/norecipe.log" | head -n1 | sed 's/apt-get install -y //')"
printed_sorted="$(printf '%s\n' $printed | sort | tr '\n' ' ')"
check "the remedy it PRINTS is the generated set, not a hand-kept copy of it" \
  "[ '$printed_sorted' = '$gen_sorted' ]"
check "and so is the one the capability refusal prints, which nothing read before" \
  "[ '$caps_sorted' = '$gen_sorted' ]"


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
import sys, pathlib
lines = open(sys.argv[1]).read().splitlines()
out = pathlib.Path(sys.argv[2])

def bounds(name):
    i = next(k for k, l in enumerate(lines) if l.strip().startswith("- name:") and name in l)
    # Stop at the NEXT step. Without a boundary, a step that stops using a block scalar
    # makes this silently return the following step's script, and the checks then fail
    # about properties of a step that was never found.
    end = next((k for k in range(i + 1, len(lines)) if lines[k].strip().startswith("- name:")), len(lines))
    return i, end

def block(name):
    i, end = bounds(name)
    return "\n".join(lines[i:end]).rstrip() + "\n"

def script(name):
    i, end = bounds(name)
    j = next((k for k in range(i, end) if lines[k].strip() in ("run: |", "run: |-")), None)
    if j is None:
        raise SystemExit(f"step {name!r} has no `run: |` block")
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
# The step's WHOLE block, env and `if:` included. Grepping the file instead proved only
# that a string exists SOMEWHERE in it: moving `if: failure()` onto the probe step, which
# would page on every run and fail the probe on none, left every check green.
(out / "probe-step.yml").write_text(block("probe the live faucet"))
(out / "page-step.yml").write_text(block("page on"))
PY
check "the workflow's two steps could be extracted, so what follows is the shipped script" \
  "[ -s '$T/probe-step.sh' ] && [ -s '$T/page-step.sh' ]"
# And they are the RIGHT two: a boundary bug that returned the same block twice would
# otherwise be reported as a pile of failures about the step it never found.
check "the probe step is the probe step, and the page step is the page step" \
  "grep -q 'live-probe.mjs' '$T/probe-step.sh' && ! grep -q 'gh run list' '$T/probe-step.sh' && grep -q 'gh run list' '$T/page-step.sh'"

# THE ENV BLOCK IS PART OF THE STEP. Extracting only `run:` left the mapping invisible:
# renaming the secret to FAUCET_ALERT_URL_TYPO turned every outage into "cannot page
# (email only)", green, and no check moved.
check "the probe step is handed the URL, the hatch and the off switch" \
  "grep -q 'SMOKE_URL: ..{ vars.FAUCET_LIVE_URL }' '$T/probe-step.yml' && grep -q 'SMOKE_ALLOW_UNREADY: ..{ vars.FAUCET_LIVE_ALLOW_UNREADY }' '$T/probe-step.yml' && grep -q 'SMOKE_DISABLED: ..{ vars.FAUCET_LIVE_SMOKE_DISABLED }' '$T/probe-step.yml'"
check "the page step is handed the URL it re-probes, and the probe step's guards verdict" \
  "grep -q 'SMOKE_URL: ..{ vars.FAUCET_LIVE_URL }' '$T/page-step.yml' && grep -q 'PROBE_GUARDS: ..{ steps.probe.outputs.guards }' '$T/page-step.yml'"
check "the page step is handed the webhook secret and a token to read run history with" \
  "grep -q 'ALERT_URL: ..{ secrets.FAUCET_ALERT_URL }' '$T/page-step.yml' && grep -q 'GH_TOKEN: ..{ github.token }' '$T/page-step.yml'"
# `failure() || cancelled()`, exactly. A job that hits its budget concludes cancelled, and
# a `failure()`-only page step never ran on one (#503). And on the PAGE step only: on the
# probe it would page every run and probe none.
check "and it runs when the probe failed OR the job was cut off, on the PAGE step and not the probe" \
  "grep -q 'if: failure() || cancelled()' '$T/page-step.yml' && ! grep -q '^ *if:' '$T/probe-step.yml'"
# THE PROBE STEP CARRIES ITS OWN BUDGET, BELOW THE JOB'S. A hung probe that reaches the
# JOB budget is a cancelled run: no failure() step, and the next run's previous-run filter
# skips cancelled, so every hung run in an outage would look like the first. A step that
# hits ITS budget fails, which is the shape the paging understands. The two numbers are
# read and compared rather than pinned, so raising one with a measurement does not need
# a test edit - only inverting them does.
job_budget="$(awk '/^    timeout-minutes:[[:space:]]*[0-9]+/ { sub(/.*timeout-minutes:[[:space:]]*/, ""); sub(/[[:space:]].*/, ""); print; exit }' "$LS")"
step_budget="$(grep -oE '^ *timeout-minutes: *[0-9]+' "$T/probe-step.yml" | grep -oE '[0-9]+$' || true)"
check "the probe step has a budget of its own" "[ -n '$step_budget' ]"
check "and it is below the job's, so a hung probe FAILS before the job is cancelled" \
  "[ -n '$step_budget' ] && [ -n '$job_budget' ] && [ '$step_budget' -lt '$job_budget' ]"
# The page step's own budget has to hold the wait AND a probe, and probe + page have to
# fit under the job's, or a re-probe that hangs cancels the job and pages nothing.
page_budget="$(grep -oE '^ *timeout-minutes: *[0-9]+' "$T/page-step.yml" | grep -oE '[0-9]+$' || true)"
check "the page step has a budget of its own that holds the 25-minute wait and a probe" \
  "[ -n '$page_budget' ] && [ '$page_budget' -ge 30 ]"
check "and probe + page budgets fit under the job's" \
  "[ -n '$page_budget' ] && [ -n '$step_budget' ] && [ -n '$job_budget' ] && [ \$(( page_budget + step_budget )) -lt '$job_budget' ]"
check "the wait is a constant in the workflow, not a Settings variable" \
  "grep -q 'REPROBE_WAIT_MIN=25' '$T/page-step.sh' && ! grep -qi 'vars\..*REPROBE' '$LS'"
check "the re-probe is handed the same un-ready hatch as the first probe" \
  "grep -q 'SMOKE_ALLOW_UNREADY: ..{ vars.FAUCET_LIVE_ALLOW_UNREADY }' '$T/page-step.yml'"
check "the cron keeps off the quarter-hours GitHub drops most" \
  "grep -qE 'cron: \"4,19,34,49 \\* \\* \\* \\*\"' '$LS'"
check "the page step is told how the probe ended, from the probe step by id" \
  "grep -q 'id: probe' '$T/probe-step.yml' && grep -q 'PROBE_OUTCOME: ..{ steps.probe.outcome }' '$T/page-step.yml'"
check "the cap knob is NOT settable from the workflow, so a variable cannot widen it" \
  "! grep -q 'SMOKE_ALLOW_UNREADY_MAX_DAYS' '$LS'"
# Same shape, same reason: OBSERVABILITY.md says the certificate floor is deliberately not
# plumbed into a repository variable, because widening it is a way to silence the check
# rather than fix it. A documented invariant with no guard is a comment.
check "and neither is the certificate floor" \
  "! grep -q 'SMOKE_TLS_MIN_DAYS' '$LS'"
# The https guard, both ways round: an uppercase scheme is legal and must not page.
# NOT SMOKE_DISABLED=1: that hits the off switch at the top of the step and exits 0 before
# the scheme is ever looked at, so the check passed on a byte-exact mutant of the guard it
# was written for. The step has to reach the case, which means it also reaches `node`, so
# node is stubbed the way the page step's tools are.
# ITS OWN DIR, not the $T/bin the page step's gh and curl stubs live in: anything added to
# that block later would silently get this node too.
mkdir -p "$T/nodebin"
printf '#!/usr/bin/env bash\necho "stub node ran: $*"\n' > "$T/nodebin/node"
chmod +x "$T/nodebin/node"
# GITHUB_OUTPUT is where the step records that its checks passed (the page step reads
# it before re-probing, R-21); GitHub always sets it, so the runs here do too.
export GITHUB_OUTPUT="$T/probe.out"; : > "$GITHUB_OUTPUT"
( cd "$REPO" && PATH="$T/nodebin:$BASE_PATH" SMOKE_URL="HTTPS://faucet.example.org" SMOKE_DISABLED="" \
    bash "$T/probe-step.sh" > "$T/upper.log" 2>&1 )
rc=$?
check "an uppercase HTTPS:// is accepted, because new URL() normalises it and a refusal pages" \
  "[ $rc -eq 0 ] && ! grep -q 'which is not https' '$T/upper.log'"
check "and the step really got past the scheme check, rather than exiting before it" \
  "grep -q 'stub node ran' '$T/upper.log'"
check "and recorded guards=ok for the page step, BEFORE the probe ran" \
  "grep -qx 'guards=ok' '$GITHUB_OUTPUT'"
# The two other forms new URL() accepts. Refusing either pages a human for a variable that
# would have worked, which is the harm the fold was added for.
( cd "$REPO" && PATH="$T/nodebin:$BASE_PATH" SMOKE_URL=" https://faucet.example.org " SMOKE_DISABLED="" \
    bash "$T/probe-step.sh" > "$T/ws.log" 2>&1 )
check "surrounding whitespace does not turn a good URL into a page" \
  "[ $? -eq 0 ] && grep -q 'stub node ran' '$T/ws.log'"
( cd "$REPO" && PATH="$T/nodebin:$BASE_PATH" SMOKE_URL="https:faucet.example.org" SMOKE_DISABLED="" \
    bash "$T/probe-step.sh" > "$T/noslash.log" 2>&1 )
check "and neither does https: with no slashes, which new URL() normalises" \
  "[ $? -eq 0 ] && grep -q 'stub node ran' '$T/noslash.log'"
( cd "$REPO" && PATH="$T/nodebin:$BASE_PATH" SMOKE_URL="https:/faucet.example.org" SMOKE_DISABLED="" \
    bash "$T/probe-step.sh" > "$T/oneslash.log" 2>&1 )
check "nor one dropped slash, which the probe runs clean on" \
  "[ $? -eq 0 ] && grep -q 'stub node ran' '$T/oneslash.log'"

# The probe step, run for real. `node scripts/live-probe.mjs` is never reached in these
# two cases, which is the point: both must decide before probing anything.
: > "$GITHUB_OUTPUT"
( cd "$REPO" && SMOKE_URL="" SMOKE_DISABLED="" bash "$T/probe-step.sh" > "$T/nourl.log" 2>&1 )
rc=$?
# Not just non-zero: bash exits 127 for a script that does not exist, so an extractor
# that wrote nothing would have satisfied `-ne 0` while proving nothing ran.
check "an unset FAUCET_LIVE_URL FAILS the step, rather than skipping green" "[ $rc -ne 0 ] && [ $rc -ne 127 ]"
check "and says what it has been doing" "grep -q 'probed NOTHING' '$T/nourl.log'"
check "and records NO guards=ok, so the page step will not re-probe a missing URL" "! grep -q 'guards=ok' '$GITHUB_OUTPUT'"
( cd "$REPO" && SMOKE_URL="" SMOKE_DISABLED="1" bash "$T/probe-step.sh" > "$T/off1.log" 2>&1 )
check "the named off switch exits 0 with no URL" "[ $? -eq 0 ] && grep -q 'deliberately off' '$T/off1.log'"
( cd "$REPO" && SMOKE_URL="https://example.invalid" SMOKE_DISABLED="1" bash "$T/probe-step.sh" > "$T/off2.log" 2>&1 )
check "and ALSO with a URL set, which is when a maintenance window needs it" "[ $? -eq 0 ] && grep -q 'deliberately off' '$T/off2.log'"
# Caddy 308s :80 to :443 and fetch follows redirects, so an http origin passes every
# faucet check while the certificate check is skipped: off-box TLS monitoring absent for
# ever behind a green run, from one mistyped variable.
: > "$GITHUB_OUTPUT"
( cd "$REPO" && SMOKE_URL="http://faucet.example.org" SMOKE_DISABLED="" bash "$T/probe-step.sh" > "$T/http.log" 2>&1 )
check "an http FAUCET_LIVE_URL FAILS the step rather than skipping the certificate check" \
  "[ $? -ne 0 ] && grep -q 'which is not https' '$T/http.log'"
# THE RE-PROBE MUST NOT UNDO THIS. live-probe.mjs run bare follows Caddy's 308 and SKIPS the
# certificate check on an http URL, so a re-probe that skipped the scheme check would
# turn this refusal into "a blip, not paging" 25 minutes later (review of #525).
check "and records NO guards=ok, so the re-probe cannot run the probe past a check it failed" \
  "! grep -q 'guards=ok' '$GITHUB_OUTPUT'"
unset GITHUB_OUTPUT

# The page step, run for real against a stub gh/curl. This is the 30-minute rule.
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
# APPLIES THE WORKFLOW'S OWN --jq FILTER to a fixture list, with real jq. A stub that
# just printed the fixture answered any query, so deleting `--event schedule` or the
# conclusion filter from the workflow changed nothing here; the filter is most of the
# rule. The flags jq cannot express are asserted instead.
#
# REFUSALS GO TO THE LOG, NOT STDERR. The workflow runs this as `gh ... 2>/dev/null`,
# so a diagnostic on stderr is discarded and the check that reads the step's output
# could never fail. That is the false-pass shape this whole block exists to close, so
# it does not get to live inside it.
echo "gh $*" >> "${STUB_GH_LOG:?}"
refuse() { echo "stub gh: $1" >> "$STUB_GH_LOG"; echo "stub gh: $1" >&2; exit "$2"; }
# `--workflow live-smoke`: without it, the query reads whatever ran last in the repo.
# One green ci run then reads as "first failure: not paging yet" and the outage page is
# suppressed, which is precisely the under-alerting this backstop exists to prevent.
case "$*" in
  *"--workflow live-smoke "*|*"--workflow live-smoke") ;;
  *) refuse "query does not name --workflow live-smoke: $*" 92 ;;
esac
# Exact value, not a prefix: real gh rejects `--event scheduleXYZ`, so accepting it here
# would let a typo through the test that production would reject.
case "$*" in
  *"--event schedule "*|*"--event schedule") ;;
  *) refuse "query does not filter --event schedule: $*" 90 ;;
esac
filter=""
while [ $# -gt 0 ]; do
  case "$1" in --jq) filter="$2"; shift 2 ;; *) shift ;; esac
done
[ -n "$filter" ] || refuse "no --jq filter in the query" 91
jq -r "$filter" < "${STUB_PREV_JSON:?}"
GH
cat > "$T/bin/curl" <<'CURL'
#!/usr/bin/env bash
echo "curl $*" >> "${STUB_CURL_LOG:?}"
exit 0
CURL
# THE RE-PROBE (R-21): the page step sleeps and runs the probe again. Both are stubbed
# so the case takes no 25 minutes, and both are logged so a case can say the wait was
# asked for in full and the probe was the shipped one.
# Logged to BOTH logs: its order against the gh query lives in gh.log, its order
# against the probe in curl.log.
cat > "$T/bin/sleep" <<'SLEEP'
#!/usr/bin/env bash
echo "sleep $*" >> "${STUB_CURL_LOG:?}"
echo "sleep $*" >> "${STUB_GH_LOG:?}"
exit 0
SLEEP
cat > "$T/bin/node" <<'NODE'
#!/usr/bin/env bash
echo "node $*" >> "${STUB_CURL_LOG:?}"
exit "${STUB_REPROBE_RC:-1}"
NODE
chmod +x "$T/bin/gh" "$T/bin/curl" "$T/bin/sleep" "$T/bin/node"
export STUB_CURL_LOG="$T/curl.log" STUB_GH_LOG="$T/gh.log"
# $1 = the run LIST the API would return, newest first; the workflow's own --jq picks
# from it, so the selection itself is under test.
page_run() {
  : > "$STUB_CURL_LOG"; : > "$STUB_GH_LOG"
  printf '%s' "$1" > "$T/prev.json"
  ( cd "$REPO" && PATH="$T/bin:$BASE_PATH" STUB_PREV_JSON="$T/prev.json" STUB_GH_LOG="$STUB_GH_LOG" \
      ALERT_URL="https://hook.example/x" ALERT_FORMAT="" GH_TOKEN=x SMOKE_URL="https://f.example" \
      PROBE_OUTCOME="${PAGE_PROBE_OUTCOME:-failure}" PROBE_GUARDS="${PAGE_PROBE_GUARDS-ok}" \
      GITHUB_RUN_ID=999 GITHUB_SERVER_URL=https://github.com GITHUB_REPOSITORY=o/r \
      bash "$T/page-step.sh" > "$T/page.log" 2>&1 )
}
old="$(date -u -d '-300 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-300M +%Y-%m-%dT%H:%M:%SZ)"
recent="$(date -u -d '-10 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)"
# The negatives need a control: "no curl" is also what a step that never ran looks like,
# and this suite has been bitten by exactly that (a missing python3 made three checks
# pass while nothing executed). Each asserts the step ran AND said why it held back.
# THE FIRST FAILURE RE-PROBES FROM INSIDE THE JOB (R-21). Measured over 100 scheduled
# runs, leaving the second look to the next cron paged a dead box a median 212 minutes
# after the first red. The 30 minutes are covered by a wait in this step, not by GitHub.
STUB_REPROBE_RC=0 page_run "[{\"conclusion\":\"success\",\"databaseId\":1,\"createdAt\":\"$old\"}]"
check "a previous SUCCESS waits 25 minutes IN THE JOB and probes again" \
  "grep -q 'first failure: re-probing in 25 minutes' '$T/page.log' && grep -qx 'sleep 1500' '$STUB_CURL_LOG' && grep -q 'node scripts/live-probe.mjs' '$STUB_CURL_LOG'"
check "and a re-probe that passes is a blip: no page" \
  "! grep -q 'curl ' '$STUB_CURL_LOG' && grep -q 'a blip, not paging' '$T/page.log'"
check "and the wait comes after the previous run was read, not before, and exactly once" \
  "[ \"\$(grep -n 'gh run list' '$STUB_GH_LOG' | head -1 | cut -d: -f1)\" -lt \"\$(grep -n 'sleep 1500' '$STUB_GH_LOG' | head -1 | cut -d: -f1)\" ] && [ \"\$(grep -c 'sleep' '$STUB_GH_LOG')\" -eq 1 ]"
STUB_REPROBE_RC=1 page_run "[{\"conclusion\":\"success\",\"databaseId\":1,\"createdAt\":\"$old\"}]"
check "and a re-probe that FAILS pages from this run, 25 minutes after the first red" \
  "grep -q 'curl ' '$STUB_CURL_LOG' && grep -q 'has failed two probes 25 minutes apart spanning 25+ minutes' '$STUB_CURL_LOG'"
check "and the re-probe ran AFTER the full wait, not alongside it" \
  "[ \"\$(grep -n 'sleep 1500' '$STUB_CURL_LOG' | head -1 | cut -d: -f1)\" -lt \"\$(grep -n 'node scripts/live-probe.mjs' '$STUB_CURL_LOG' | head -1 | cut -d: -f1)\" ]"
STUB_REPROBE_RC=1 page_run "[{\"conclusion\":\"failure\",\"databaseId\":1,\"createdAt\":\"$recent\"}]"
check "two failures only 10 minutes apart re-probe to cover the 30-minute rule, and page on a third red" \
  "grep -q 'only 10 minutes apart: re-probing' '$T/page.log' && grep -q 'curl ' '$STUB_CURL_LOG' && grep -qE 'spanning 3[5-6]\+ minutes' '$STUB_CURL_LOG'"
page_run "[{\"conclusion\":\"cancelled\",\"databaseId\":1,\"createdAt\":\"$recent\"},{\"conclusion\":\"failure\",\"databaseId\":2,\"createdAt\":\"$old\"}]"
check "a CANCELLED run is not the previous run: the older real failure is, and it pages" \
  "grep -q 'curl ' '$STUB_CURL_LOG'"
page_run "[{\"conclusion\":\"failure\",\"databaseId\":1,\"createdAt\":\"$old\"}]"
check "two failures spanning 300 minutes DO page" "grep -q 'curl ' '$STUB_CURL_LOG'"
check "and the message carries the real span, not an assumed 30" "grep -qE 'spanning 3[0-9][0-9]\+ minutes' '$T/page.log' '$STUB_CURL_LOG'"
check "and says the probes FAILED, because they did" "grep -q 'has failed consecutive probes' '$STUB_CURL_LOG'"
# THE CUT-OFF RUN. The probe step did not reach a verdict (the job budget, or a person
# cancelled the run); the page step still runs, still applies the 30-minute rule, and the
# message says what happened rather than claiming a failure nobody observed.
PAGE_PROBE_OUTCOME=cancelled page_run "[{\"conclusion\":\"failure\",\"databaseId\":1,\"createdAt\":\"$old\"}]"
check "a run cut off after an old failure still pages" "grep -q 'curl ' '$STUB_CURL_LOG'"
check "and the message says the probe reached no verdict, not that it failed" \
  "grep -q 'was not probed to a verdict (probe step outcome: cancelled)' '$STUB_CURL_LOG' && ! grep -q 'has failed consecutive' '$STUB_CURL_LOG'"
# A GREEN probe under a cancelled run (a person cancelled in the second between the probe
# passing and this step starting) is nothing to page about, whatever the previous run was.
# Without this arm the `*)` branch paged "not probed to a verdict (outcome: success)" on a
# recovery run, and only the `if:` pin stood between that and paging on every recovery.
PAGE_PROBE_OUTCOME=success page_run "[{\"conclusion\":\"failure\",\"databaseId\":1,\"createdAt\":\"$old\"}]"
check "a run cut off AFTER a green probe does not page: the probe passed" \
  "! grep -q 'curl ' '$STUB_CURL_LOG' && grep -q 'the probe passed, nothing to page' '$T/page.log'"
STUB_REPROBE_RC=0 PAGE_PROBE_OUTCOME=cancelled page_run "[{\"conclusion\":\"success\",\"databaseId\":1,\"createdAt\":\"$old\"}]"
check "a run cut off after a SUCCESS re-probes like a first failure, and does not page when the faucet answers" \
  "! grep -q 'curl ' '$STUB_CURL_LOG' && grep -q 'first failure: re-probing' '$T/page.log' && grep -q 'a blip, not paging' '$T/page.log'"
STUB_REPROBE_RC=1 PAGE_PROBE_OUTCOME=cancelled page_run "[{\"conclusion\":\"success\",\"databaseId\":1,\"createdAt\":\"$old\"}]"
check "and when the re-probe then fails, the message says the first probe reached no verdict, not that it failed" \
  "grep -q 'curl ' '$STUB_CURL_LOG' && grep -q 'was not probed to a verdict (probe step outcome: cancelled), then failed a re-probe 25 minutes later' '$STUB_CURL_LOG' && ! grep -q 'has failed two probes' '$STUB_CURL_LOG'"
# THE PROBE THAT NEVER RAN. A failed checkout leaves the probe step skipped, an http URL
# fails it on its own check; neither wrote guards=ok. Re-running node bare would either
# fail on a missing script and page a runner fault as an outage 25 minutes later, or pass
# on an http URL and call a misconfiguration a blip. Nothing to re-probe, not paging.
STUB_REPROBE_RC=1 PAGE_PROBE_GUARDS="" PAGE_PROBE_OUTCOME=skipped page_run "[{\"conclusion\":\"success\",\"databaseId\":1,\"createdAt\":\"$old\"}]"
check "a probe that never got past its own checks is not re-probed and does not page" \
  "! grep -q 'curl ' '$STUB_CURL_LOG' && ! grep -q 'node scripts/live-probe.mjs' '$STUB_CURL_LOG' && grep -q 'nothing to re-probe, not paging yet' '$T/page.log'"
STUB_REPROBE_RC=1 PAGE_PROBE_GUARDS="" page_run "[{\"conclusion\":\"failure\",\"databaseId\":1,\"createdAt\":\"$old\"}]"
check "but a second failure 30+ minutes after the first still pages without one, guards or not" \
  "grep -q 'curl ' '$STUB_CURL_LOG' && ! grep -q 'node scripts/live-probe.mjs' '$STUB_CURL_LOG'"
check "and it says the schedule is not keeping its cron" "grep -q 'not the 15 the cron asks for' '$T/page.log'"
page_run "[]"
check "an unreadable previous run PAGES rather than exiting quietly" "grep -q 'curl ' '$STUB_CURL_LOG'"
# THE RUN EXCLUDES ITSELF. GITHUB_RUN_ID is 999 above, so without the self-exclusion the
# query's first hit is this very run, ten minutes old, and the 30-minute rule swallows a
# real outage. With it, the older failure is the previous run and it pages.
page_run "[{\"conclusion\":\"failure\",\"databaseId\":999,\"createdAt\":\"$recent\"},{\"conclusion\":\"failure\",\"databaseId\":2,\"createdAt\":\"$old\"}]"
check "the running job is not its own previous run: the older failure is, and it pages" \
  "grep -q 'curl ' '$STUB_CURL_LOG'"
# The stub logs its refusals to STUB_GH_LOG on purpose: the workflow discards gh's stderr,
# so asserting on the step's output could not fail here.
check "the query was actually run, and the stub accepted it: right workflow, scheduled, by conclusion" \
  "grep -q 'gh run list' '$STUB_GH_LOG' && ! grep -q 'stub gh:' '$STUB_GH_LOG'"

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

# THE PROXY LOG HOLDS NO IP AND NO QUERY STRING (risk register II, R-36). Two log
# blocks, the site's access log and the global default that the error logger
# writes through, each filtered the same way: a line that kept either half would be
# the IP-to-txid record PRIVACY.md says nobody keeps. Counted, not grepped once, so
# dropping the filter from one block cannot pass on the other. Measured with the
# pinned image: the error logger writes the full request on every upstream 502.
CF="$REPO/deploy/z3/Caddyfile"
check "the Caddyfile's access log and its default (error) log both drop the client and remote IP" \
  "[ \"\$(grep -c 'request>remote_ip delete' '$CF')\" = 2 ] && [ \"\$(grep -c 'request>client_ip delete' '$CF')\" = 2 ]"
check "and both drop the whole query string from the URI, not named keys that a new route could miss" \
  "[ \"\$(grep -cF 'request>uri regexp \\?.*\$ \"\"' '$CF')\" = 2 ]"
check "and both drop every request header, not a named list that Sec-CH-UA or X-Real-IP would walk past" \
  "[ \"\$(grep -c 'request>headers delete' '$CF')\" = 2 ] && ! grep -q 'request>headers>' '$CF'"
check "and both strip the query from Location, which a redirect fills with the full URL" \
  "[ \"\$(grep -cF 'resp_headers>Location regexp \\?.*\$ \"\"' '$CF')\" = 2 ]"
check "and the default logger is actually declared, so the filter reaches the error log" \
  "grep -qE '^\s*log default \{' '$CF'"
check "and PRIVACY.md says what a proxy line keeps, what it drops, and for how long" \
  "grep -q 'Dropped:' '$REPO/PRIVACY.md' && grep -q 'three 10 MB files' '$REPO/PRIVACY.md' && grep -q 'max-size\": \"10m\"' '$REPO/deploy/cloud-init.yaml' && grep -q 'max-file\": \"3\"' '$REPO/deploy/cloud-init.yaml'"
check "the balance lookup takes the address in a POST body, and the page sends it that way" \
  "grep -q 'export const POST = withApi(\"balance\"' '$REPO/src/app/api/balance/route.ts' && ! grep -qE 'searchParams|URLSearchParams' '$REPO/src/app/api/balance/route.ts' && ! grep -qE '/api/balance\\?|URLSearchParams' '$REPO/src/app/page.tsx'"
check "the probe has tests, and npm test runs them" \
  "[ -f '$REPO/scripts/live-probe.test.mjs' ] && grep -q 'scripts/\*\*/\*.test.mjs' '$REPO/package.json'"

# THE BOX ANSWERS IN GITHUB (#721's follow-up). Two rows the probe now makes, and the workflow
# has to feed both steps the same way, or the re-probe in the page step judges by a different
# rule than the probe it confirms - which is the trap the page step's own comments name.
check "the probe asserts the box's drift verdict, judged by the word, only clean passing" \
  "grep -q 'the box.s drift audit reads clean' '$REPO/scripts/live-probe.mjs' && grep -q 'driftWord === \"clean\"' '$REPO/scripts/live-probe.mjs'"
check "and asserts the box runs main, with git, not by printing the commit" \
  "grep -q 'the box runs main' '$REPO/scripts/live-probe.mjs' && grep -q 'merge-base' '$REPO/scripts/live-probe.mjs'"
check "the checkout has full history, or the ancestor question cannot be answered" \
  "grep -qE '^\s+fetch-depth: 0' '$LS'"
check "the probe step names the ref to compare against" \
  "grep -q 'SMOKE_MAIN_REF: origin/main' '$T/probe-step.yml'"
check "and so does the page step's re-probe, with the token that buys buildCommit" \
  "grep -q 'SMOKE_MAIN_REF: origin/main' '$T/page-step.yml' && grep -q 'SMOKE_OPS_TOKEN: ..{ secrets.FAUCET_OPS_TOKEN }' '$T/page-step.yml'"
# Every SMOKE_* the probe step sets, the page step sets too, so a knob added to one and not the
# other cannot make the re-probe a different probe. Read from the two blocks, compared as sets.
PROBE_KNOBS="$(grep -oE '^\s+SMOKE_[A-Z_]+:' "$T/probe-step.yml" | tr -d ' :' | sort -u)"
PAGE_KNOBS="$(grep -oE '^\s+SMOKE_[A-Z_]+:' "$T/page-step.yml" | tr -d ' :' | sort -u)"
check "every SMOKE_ knob the probe step sets, the page step sets: $(comm -23 <(printf '%s\n' "$PROBE_KNOBS") <(printf '%s\n' "$PAGE_KNOBS") | tr '\n' ' ')" \
  "[ -n '$PROBE_KNOBS' ] && [ \"\$(comm -23 <(printf '%s\n' \"\$PROBE_KNOBS\") <(printf '%s\n' \"\$PAGE_KNOBS\") | wc -l)\" -eq 0 ]"

echo "== repo: the harness reports where its own wall clock went"
# THIS IS A TEXT PIN AND THAT IS ALL IT CAN BE from in here: repo.sh runs INSIDE the
# harness, and the slowest-checks report is printed after every suite has finished, so
# the thing it holds cannot be observed from a suite. Same limit as the node-script pins
# - the behaviour is proved in the PR by running the harness and reading the report, and
# by deleting the append and watching these go red. Pinned anyway, because the report is
# the only thing that makes the NEXT four-minute sleeper visible without someone timing
# the suite by hand, and a silent deletion would take that away with nothing saying so.
check "every result records the wall clock before it, not the eval inside check()" \
  "grep -qF '_hz_mark \"\$1\"; pass=' '$REPO/deploy/z3/tests/lib.sh' && grep -qF '_hz_mark \"\$1\"; fail=' '$REPO/deploy/z3/tests/lib.sh'"
check "and does it with the bash builtin, so 2000-odd checks cost no subprocesses" \
  "grep -qF 'local now=\$(( \${EPOCHREALTIME/[.,]/} ))' '$REPO/deploy/z3/tests/lib.sh' && ! grep -q 'now=\$(date' '$REPO/deploy/z3/tests/lib.sh'"
check "the runner prints the slowest checks and counts the ones over 10s" \
  "grep -qF 'where the time went' '$REPO/deploy/z3/tests/run-tests.sh' && grep -qF '\$1 > 10000000' '$REPO/deploy/z3/tests/run-tests.sh'"

# AND THIS ONE IS NOT A PIN, because this property CAN be observed from in here: it is about
# what a child process inherits, and a child is two lines away. The timing path is a plain
# shell variable, so a nested run only collides with its parent when the path arrived
# EXPORTED - which is exactly the shape a human uses (`HARNESS_TIMING=/x ./run-tests.sh`) and
# which CI never uses, so the damage is invisible on every green run we have. repo.sh starts
# ten nested run-tests.sh runs; each sources lib.sh, truncates the inherited path and deletes
# it on exit, and the parent's report silently drops every row from before the first one.
# Measured on this tree: 216 rows with nothing exported, 34 with it exported.
# The toy below is the two levels and nothing else, so it costs two bash starts, not a suite.
mk_scratch "${TMPDIR:-/tmp}/repo-timing.XXXXXX"
cp -r "$REPO/deploy/z3/tests" "$T/tt"
cat > "$T/tt/nested.sh" <<'NESTED'
cd "$(dirname "$0")" && . ./lib.sh && ok "a row from the nested run"
NESTED
# The parent records a row, runs the child, then copies the file BEFORE its own EXIT trap
# removes it - the trap is the harness cleaning up after itself and is not what is on trial.
cat > "$T/tt/outer.sh" <<'OUTER'
cd "$(dirname "$0")"
. ./lib.sh
ok "a row from the caller"
bash ./nested.sh
cp "$HARNESS_TIMING" "$OUT" 2>/dev/null || true
OUTER
( cd "$T/tt" && HARNESS_TIMING="$T/inherited.txt" OUT="$T/kept.txt" bash "$T/tt/outer.sh" >/dev/null 2>&1 )
check "a nested harness run does not clobber the timing file of the run that started it" \
  "grep -q 'a row from the caller' '$T/kept.txt'"
# Same toy, unexported, so a pass above cannot be the child simply never running.
#
# `env -u HARNESS_TIMING` IS WHAT MAKES THIS PARTNER INDEPENDENT, and without it the partner
# shares the failure it exists to rule out (SDE-App, review of #585). The mutant for the check
# above is "delete `export -n` from lib.sh", and in exactly that configuration the harness's own
# HARNESS_TIMING keeps its export attribute - so this invocation inherits it too, the
# "unexported" toy is exported, and BOTH lines go red from one cause. Two red lines reading as
# two independent kills is the attribution error L26 is about, arriving in the assertion written
# to prevent it. Unset here and the partner stays GREEN under that mutant, which is the whole
# point of a partner.
( cd "$T/tt" && env -u HARNESS_TIMING OUT="$T/kept2.txt" bash "$T/tt/outer.sh" > "$T/toy.log" 2>&1 )
check "and the toy's two levels both really ran, so the check above is not vacuous" \
  "grep -q 'a row from the caller' '$T/kept2.txt' && grep -q 'a row from the nested run' '$T/toy.log'"
# AND THE ONE CASE THAT BROKE THE RULE STAYS FIXED. A pin on the knobs, not on a duration:
# timing assertions go red on a loaded runner, which teaches people to re-run CI.
# AND THE SHIPPED DEFAULTS ARE ANCHORED, because removing the sleep removed the only thing that
# ran them (SDE-App, review of this PR, and it is my own memory's lesson used against me). Before
# this PR the ready-gate case exercised ZSNAP_READY_TRIES=10 and ZSNAP_READY_WAIT=30 by sitting
# through them - incidentally, which is exactly why it cost 270 seconds. THE 4m32s AND THE
# COVERAGE WERE THE SAME FACT. Now all three uses in the suite are overrides, so 10 could become
# 1 and 30 could become 0 and the harness would stay green, on the two numbers that gate a
# stale-snapshot export.
#
# Text pins rather than a restored sleep: what is at risk is the VALUE, and a test that spends
# four and a half minutes to read two integers is the thing this PR exists to delete.
check "the shipped ready-probe count is anchored, not only overridden in the suite" \
  "grep -qF 'ZSNAP_READY_TRIES=\"\${ZSNAP_READY_TRIES:-10}\"' '$REPO/deploy/z3/zsnap-export.sh'"
check "and the shipped gap between probes" \
  "grep -qF 'ZSNAP_READY_WAIT=\"\${ZSNAP_READY_WAIT:-30}\"' '$REPO/deploy/z3/zsnap-export.sh'"
# AND THE OPERATOR'S SENTENCE IS DERIVED FROM THEM, not typed beside them. The refusal says
# "over ~N min", and N is computed from the two knobs; a literal there would go stale the first
# time either number moved, and the operator would be told a duration the script does not wait.
# AND THE OPERATOR'S DOC CARRIES THE SAME TWO NUMBERS. SNAPSHOTS.md tells whoever is holding
# the pager "default 10 probes 30s apart", which is how long they will wait before the export
# gives up. Typed beside the script rather than derived from it, so moving either knob leaves
# the doc quietly wrong - and a doc that is quietly wrong about a wait is worse than one that
# says nothing, because it is believed.
SNAP_MD="$REPO/deploy/z3/SNAPSHOTS.md"
check "SNAPSHOTS.md quotes the shipped probe count and gap, not numbers of its own" \
  "grep -qF 'default $(sed -nE 's/^ZSNAP_READY_TRIES=\"\$\{ZSNAP_READY_TRIES:-([0-9]+)\}\".*/\1/p' "$REPO/deploy/z3/zsnap-export.sh") probes $(sed -nE 's/^ZSNAP_READY_WAIT=\"\$\{ZSNAP_READY_WAIT:-([0-9]+)\}\".*/\1/p' "$REPO/deploy/z3/zsnap-export.sh")s apart' '$SNAP_MD'"
check "and the refusal's ~N min is computed from those two, so it cannot go stale" \
  "grep -qF 'over ~\$((ZSNAP_READY_TRIES * ZSNAP_READY_WAIT / 60)) min' '$REPO/deploy/z3/zsnap-export.sh'"
check "zsnap's ready-gate case overrides the probe knobs instead of sleeping 4.5 minutes" \
  "grep -qF 'STUB_READY=0 ZSNAP_READY_TRIES=2 ZSNAP_READY_WAIT=1 bash \"\$EXPORT\" > \"\$T/gate.log\"' '$REPO/deploy/z3/tests/suites/zsnap.sh'"

echo "== repo: the fork-park marker is one path in three files, and the doc says what clearing it does NOT do"
# THREE COPIES OF ONE PATH: watchdog.sh writes it, auto-deploy.sh refuses on it, and
# OPERATIONS.md tells an operator where to look. A doc that names the wrong path is the
# #553 failure again - there the doc diagnosed a state backwards, and an operator following
# it would have re-run the wrong thing. Held equal here rather than trusted.
MARKER_PATH='/var/lib/faucet-watchdog/miner-parked-by-fork-heal'
# COMPOSED, not spelled: the watchdog builds the path from FORK_PARK_DIR plus the basename,
# so the assertion has to check the two halves it actually writes rather than the joined
# string. My first spelling grepped for the whole path and failed on the clean tree, which
# is the baseline earning its keep.
check "the watchdog declares the marker dir under /var/lib, not /run, so it survives a reboot" \
  "grep -qF 'WATCHDOG_FORK_PARK_DIR:-/var/lib/faucet-watchdog' '$REPO/deploy/z3/watchdog.sh'"
check "and names the marker file the other two files look for" \
  "grep -qF 'FORK_PARK_MARKER=\"\$FORK_PARK_DIR/miner-parked-by-fork-heal\"' '$REPO/deploy/z3/watchdog.sh'"
check "auto-deploy refuses on the same path the watchdog writes" \
  "grep -qF '$MARKER_PATH' '$REPO/deploy/z3/auto-deploy.sh'"
check "and OPERATIONS.md sends the operator to that same path" \
  "grep -qF '$MARKER_PATH' '$REPO/OPERATIONS.md'"
# THE SENTENCE THAT MATTERS MOST IN THAT SECTION. Removing the marker must not read as
# "and then it mines again": starting the miner is a second decision and the owner's, and a
# doc that blurred the two would hand a deploy's mistake to a human instead of fixing it.
check "and says plainly that clearing the marker does not start the miner" \
  "grep -qE 'Removing the marker does [*]{0,2}not[*]{0,2} start the miner' '$REPO/OPERATIONS.md'"

echo "== repo: the redesign's browser checks are wired, gated on a WIRING fact, and the sheets are held"
# THE GATE, pinned on both sides. Each check decides whether it APPLIES from a fact in the
# tree; the middle state - the fact is true, the selector is missing - is a FAILURE rather
# than a shrug, because a check that shrugs at a rename passes for ever after one.
#
# AND THE FACT IS A WIRING FACT, NOT A FILENAME (SDE-App, review of #562, after my first
# version keyed on a component file existing). A component lands in one PR and the view is
# wired in another, so a file marker goes true while the page is still the old markup and a
# correct tree goes red. What says the mascot is wired is page.tsx rendering it.
check "the mascot check gates on page.tsx rendering <Mascot>, not on a file existing" \
  "grep -qF 'const wired = existsSync(PAGE) && /<Mascot' '$REPO/scripts/mascot-check.mjs' && ! grep -q 'existsSync(\"src/components' '$REPO/scripts/mascot-check.mjs'"
check "and the image job's size gate reads the SAME wiring fact, so neither can skip alone" \
  "grep -qF 'grep -qE '\\''<Mascot[[:space:]/>]'\\'' src/app/page.tsx' '$CIWF'"
# AND A PAGE IS IN THE SHELL BY TWO FACTS, so the Shell extraction cannot switch this gate off
# (SDE-UI, found on the same line in #572's checker, where it was going to ship twice). One
# string in the page file was true when it was written and S5 moved it: a page joins the shell
# by rendering <Shell>, and the shell OWNS the stage, so the page file has that string zero
# times. Measured on S5's own branch: the old spelling reads 0 of 3 pages and plans 40 for ever
# while calling three redesigned pages pre-redesign; this one reads 3 of 3 and plans the
# ruling's 70. Round 5's defect inside out - that gate was off DURING the window it guards,
# this one STOPS working at the slice it exists for.
check "a page is in the shell by two facts, not by one string the extraction can move" \
  "grep -qF 'SHELL_OWNS_STAGE = existsSync(SHELL_COMPONENT)' '$REPO/scripts/fit-check.mjs' && grep -qF 'SHELL_OWNS_STAGE && /<Shell' '$REPO/scripts/fit-check.mjs'"
check "the fit check gates on the shell file S1 adds" \
  "grep -qF 'const SHELL_MARKER = \"src/app/redesign-tokens.css\"' '$REPO/scripts/fit-check.mjs'"
check "a wired page with no matching selector FAILS rather than passing quietly" \
  "grep -q 'has no .mascot-riso at' '$REPO/scripts/mascot-check.mjs' && grep -q 'is in the tree but' '$REPO/scripts/fit-check.mjs'"
check "both run in the ui job against the URL the smoke server already has" \
  "grep -qF 'node scripts/fit-check.mjs \"\$UI_SMOKE_URL\"' '$CIWF' && grep -qF 'node scripts/mascot-check.mjs \"\$UI_SMOKE_URL\"' '$CIWF'"
# The fit check waits for LIVE instead of sleeping, and a page that never gets there must be
# named and skipped, never measured. The row that proves it needs a browser, so npm test skips it
# in the app job and the ui job has to run it itself - a line that is easy to drop and quiet when
# dropped.
check "and the ui job runs fit-check's stall row, since npm test cannot" \
  "grep -qF 'node --test scripts/fit-check.test.mjs' '$CIWF'"
check "and that row asserts a stalled context is named AND unmeasured, the two halves of safe" \
  "grep -qF 'never reached LIVE' '$REPO/scripts/fit-check.test.mjs' && grep -qF 'were measured anyway' '$REPO/scripts/fit-check.test.mjs'"
# WHAT THE RUN PLANS IS HELD TO THE RULING, not to its own arrays (SDE-App, review of #563).
# Both counts derive FROM the arrays that drive the loops, so shrinking one leaves a run that
# measured everything it happened to plan - three viewports to one recomputed the total and
# every check stayed green. The numbers MASCOT.md names live beside the arrays now.
# AND THE PRODUCT, NOT ONLY ITS FACTORS. Found by re-measuring my own body's mutant rows on the
# current baseline rather than carrying their old numbers: editing RULING_COMBOS to a literal 4
# left the repo suite at 202/0, because the three constants below are pinned and the line that
# MULTIPLIES them was not. The script's own runtime guard still catches it, but the repo suite
# claimed to and did not, which is the round-6 finding in a second place - the neighbours pinned,
# the deciding line left out.
check "the mascot check plans the combinations and sectors MASCOT.md names" \
  "grep -qF 'const RULING_VIEWPORTS = 3;' '$REPO/scripts/mascot-check.mjs' && grep -qF 'const RULING_THEMES = 2;' '$REPO/scripts/mascot-check.mjs' && grep -qF 'const RULING_POINTER = 3;' '$REPO/scripts/mascot-check.mjs' && grep -qF 'const RULING_COMBOS = RULING_VIEWPORTS * RULING_THEMES;' '$REPO/scripts/mascot-check.mjs' && grep -q 'Change the arrays and these numbers together' '$REPO/scripts/mascot-check.mjs'"
check "and its dimensions are MASCOT.md's three viewports, two themes and three sectors" \
  "grep -qF 'const VIEWPORTS = [[1440, 900], [1100, 800], [390, 844]];' '$REPO/scripts/mascot-check.mjs' && grep -qF 'want: \"0% 50%\"' '$REPO/scripts/mascot-check.mjs' && grep -qF 'want: \"50% 0%\"' '$REPO/scripts/mascot-check.mjs' && grep -qF 'want: \"100% 100%\"' '$REPO/scripts/mascot-check.mjs'"
check "the fit check plans its full 168 the same way" \
  "grep -qF 'const RULING_COMBOS = 168;' '$REPO/scripts/fit-check.mjs' && grep -qF 'PLANNED !== RULING_COMBOS' '$REPO/scripts/fit-check.mjs'"
check "and its dimensions carry the sizes the clipping actually appears at, not only the brief's" \
  "grep -qF 'const SIZES = [[1440, 900], [1280, 800], [1920, 1080], [1366, 768], [1280, 720], [1024, 768]];' '$REPO/scripts/fit-check.mjs' && grep -qF 'const VIEWS = [\"claim\", \"status\", \"analytics\", \"tools\"];' '$REPO/scripts/fit-check.mjs' && grep -qF 'const PAGES = [\"/terms\", \"/donate\", \"/fund\"];' '$REPO/scripts/fit-check.mjs'"
# EVERY ARRAY THE COUNT MULTIPLIES, not the ones I happened to name (SDE-App, review of #563,
# against their own finding as I had implemented it). THEMES was pinned nowhere, so cutting it
# to one halved the coverage of both scripts while their own arithmetic still agreed with
# itself. "Pin the arrays" has to mean all of them or it is a list with a hole in it.
check "including THEMES, which both scripts multiply by and neither pinned" \
  "grep -qF 'const THEMES = [\"paper\", \"ink\"];' '$REPO/scripts/fit-check.mjs' && grep -qF 'const THEMES = [\"paper\", \"ink\"];' '$REPO/scripts/mascot-check.mjs'"
# AND POINTERS, WHICH IS THEMES ONE ROUND LATER. #598 added a pointer dimension to fit-check,
# multiplied it into RULING_COMBOS, and pinned it nowhere - so dropping `["fine", false]` would
# have halved the contract back to touch-only in two lines with every number below still
# agreeing with itself, which is exactly what the paragraph four lines up says about THEMES.
# The lesson was already written here, from SDE-App's own #563 review, and the next array still
# arrived unpinned. Found by SDE-Infra reviewing #598.
check "and POINTERS, the dimension #598 added and multiplied by" \
  "grep -qF 'const POINTERS = [[\"fine\", false], [\"coarse\", true]];' '$REPO/scripts/fit-check.mjs'"
check "and the fit check holds sizes-times-themes from the FIRST slice, not only at the end" \
  "grep -qF 'const RULING_SIZES = 6;' '$REPO/scripts/fit-check.mjs' && grep -qF 'const RULING_THEMES = 2;' '$REPO/scripts/fit-check.mjs' && grep -qF 'const RULING_POINTERS = 2;' '$REPO/scripts/fit-check.mjs' && grep -qF 'SIZES.length !== RULING_SIZES || THEMES.length !== RULING_THEMES || POINTERS.length !== RULING_POINTERS' '$REPO/scripts/fit-check.mjs'"
# FITS MEANS REACHABLE (CTO's ruling on #562, after their red-team found the clipped footer). The
# arithmetic alone called a footer that had been CUT OFF and could not be scrolled to "SCROLLS",
# on a build whose own suite read 130 ok while three links could not be clicked and prod has
# maintenanceAddress set. A check that measures a page's height and not whether anyone can reach
# what is on it is L1 in this file's own words: a proxy for the property.
check "fits means the footer is on screen and its links are hit-testable, not just the numbers" \
  "grep -qF 'document.elementFromPoint(x, y)' '$REPO/scripts/fit-check.mjs' && grep -qF 'r.links.every((l) => l.inView && l.reachable)' '$REPO/scripts/fit-check.mjs'"
# THE CLAUSE THAT DECIDES, PINNED BEFORE ITS NEIGHBOURS. My first three pins held that the
# ancestor walk RUNS and that its message EXISTS, and the CTO's round-5 mutant walked straight
# between them: drop the clipping clause out of fitsNow and the walk still runs, the string is
# still in the file, both greps pass, repo.sh stays at 199/0 - and a page hiding 216px of copy
# is reported as 40 of 40 fitting. A check can only hold the line that makes a decision; the
# lines around it are decoration. Pin the mutant the finding names FIRST, then its neighbours.
check "the clipping walk DECIDES the verdict, rather than only printing inside it" \
  "grep -A1 'const fitsNow = (r) =>' '$REPO/scripts/fit-check.mjs' | grep -qF '(r.clipping || []).length === 0 &&'"
# AND THE SCROLL IT JUDGES AFTER MUST BE ONE A PERSON COULD PERFORM. `scrollTop = ...` moves an
# overflow:hidden box perfectly well; the browser blocks the USER there, never the script. So on
# the clamp the check reached the footer itself, found every link hit-testable and reported a
# reachability a visitor does not have - and the row above named no links, because there were
# none left unreachable. Measured on a clamp fixture: without the guard every row reads
# "CLIPPED by an ancestor (div.stage hides 215px)" and stops; with it, the same row continues
# "unreachable after scrolling: Donate TAZ, Terms, GitHub". Same defect as #562's ui-smoke
# scrollIntoView, blocked earlier the same night in a second script by a second author.
check "the check only scrolls a box a person could scroll" \
  "grep -qF 'const oy = getComputedStyle(st).overflowY;' '$REPO/scripts/fit-check.mjs' && grep -qF 'if (oy !== \"hidden\" && oy !== \"clip\" && st.scrollHeight > st.clientHeight)' '$REPO/scripts/fit-check.mjs'"
check "and a clipped row names the links a person then has to go and look at" \
  "grep -qF 'CLIPPED by an ancestor (\${clipped})\${unreachable.length' '$REPO/scripts/fit-check.mjs'"
check "and clipping is named as clipping, attributed to the ancestor that hides it" \
  "grep -qF 'CLIPPED by an ancestor' '$REPO/scripts/fit-check.mjs' && grep -qF 'cs.overflowY === \"hidden\" || cs.overflowY === \"clip\"' '$REPO/scripts/fit-check.mjs'"
# THE SCROLLER IS WHICHEVER ELEMENT SCROLLS - my own defect, caught by hand on the shell that
# is now in production and BEFORE this gate was wired to anything. The first version read
# `.stage` as the scroller; once the one-screen clamp came off, the DOCUMENT scrolls and
# `.stage` does not, so the check called the correct shell CLIPPED. A gate that refuses the
# right answer is worse than no gate - it would have blocked every correct PR behind it. The
# two halves are held together because either one alone still reads the old way: the page is
# scrolled by whichever box actually scrolls, AND the row says which box it judged.
check "the check scrolls whichever box scrolls, the document included" \
  "grep -qF 'st.scrollTop = st.scrollHeight;' '$REPO/scripts/fit-check.mjs' && grep -qF 'window.scrollTo(0, document.documentElement.scrollHeight);' '$REPO/scripts/fit-check.mjs'"
check "and every row names the scroller it judged, so a wrong one is readable" \
  "grep -qF 'scroller: stScrolls ? \".stage\" : \"document\"' '$REPO/scripts/fit-check.mjs' && grep -qF 'via \${o.scroller}' '$REPO/scripts/fit-check.mjs'"
# THE SHEETS: served, and held at the size the owner ruled.
# THE BOOP NAMES ITS LAYER (CTO red-team, review of #563): `span span` matches BOTH sprite
# layers and the directions layer is opacity 1 always, so the old assertion was true before any
# click and deleting the handler outright still passed 6/6.
check "the boop finds the reactions layer by the sheet it paints, and asserts a RISE" \
  "grep -qF '(getComputedStyle(l).backgroundImage || \"\").includes(which)' '$REPO/scripts/mascot-check.mjs' && grep -q 'before any click, so a rise cannot be observed' '$REPO/scripts/mascot-check.mjs'"
# THE BYTE TEST IS THE CLAUSE THAT DECIDES, so it is pinned and not just the URLs around it.
# Same re-measurement, same shape: replacing the whole RIFF/WEBP test with `true` left the repo
# suite at 202/0. The URLs and the error string are the decoration; whether the body IS a WebP
# is the assertion, and gating that on the content-type header instead of the bytes is the
# exact mistake this check was rewritten to stop making.
check "the sheets are checked over the wire before the pointer assertions, since a 404 passes them" \
  "grep -qF '/mascots/fox-riso-directions-blindfold.webp' '$REPO/scripts/mascot-check.mjs' && grep -qF '/mascots/fox-riso-reactions-blindfold.webp' '$REPO/scripts/mascot-check.mjs' && grep -q 'is not served' '$REPO/scripts/mascot-check.mjs' && grep -qF 'body.subarray(0, 4).toString(\"latin1\") === \"RIFF\"' '$REPO/scripts/mascot-check.mjs' && grep -qF 'body.subarray(8, 12).toString(\"latin1\") === \"WEBP\"' '$REPO/scripts/mascot-check.mjs'"
check "the image job measures each sheet against MASCOT.md's 300 KB and refuses a served PNG" \
  "grep -qF 'LIMIT=307200' '$CIWF' && grep -q 'the sheets ship as WebP' '$CIWF'"
check "and the CI context probe proves the sheets reach the image, both directions" \
  "grep -qF '/ctx/public/mascots/fox-riso-directions.webp' '$CIWF' && grep -qF 'echo \"html\" > \"\$ctx/design/faucet-architecture.html\"' '$CIWF'"

echo "== repo: parity with the approved design is a committed check, against a vendored spec"
# THE SPEC IS IN THE REPO OR THE CHECK IS A STORY. A parity check that reads the live share
# directory compares against whatever the last edit did - the preview moved three times during
# one slice - so the snapshot is vendored as a golden file and the check names it.
check "the spec is vendored, not read from a directory outside the repo" \
  "[ -s '$REPO/design/spec/S1-20260915T1938Z/shell.css' ] && ! grep -q 'ipc/share' '$REPO/scripts/parity-check.mjs'"
check "and the CI step names that snapshot rather than a moving path" \
  "grep -qF 'node scripts/parity-check.mjs design/spec/S1-20260915T1938Z/shell.css' '$CIWF'"
# A DEPARTURES FILE IS A PLACE TO HIDE A DIVERGENCE unless it is held to describing one, which
# is the same shape as an override that quietly retires the default it was added to test.
check "a declaration that no longer describes a divergence fails, so the list cannot rot" \
  "grep -q 'STALE DEPARTURE, no longer differs' '$REPO/scripts/parity-check.mjs'"
# A DECLARATION NAMES WHAT WE SHIP (SDE-App predicted this before the file existed: a departures
# file is a place to hide a divergence). Declared by SELECTOR alone, a second and different
# change to an already-declared rule inherits the old label - measured, an added outline on
# .badge .dot passed with the selector declared.
check "and a declaration names the body it declares, so a second change cannot inherit its label" \
  "grep -q 'DECLARED WITH A DIFFERENT BODY' '$REPO/scripts/parity-check.mjs' && grep -qF 'a declaration must name what we ship' '$REPO/scripts/parity-check.mjs'"
# EVERY departures file, not one path. There is a file per vendored spec now: a single flat
# one looked fine until the hero was compared against S2's document and all fifteen of S1's
# declarations came back as stale, because they do not differ in a comparison they were never
# about. A pin naming one path would have gone quiet the moment the second file appeared.
# THREE HALVES NOW, NOT TWO. A departures file that mixes "we differ from the design" with "a
# floor of ours the design cannot satisfy" means neither: the count tells a reviewer nothing
# about whether the design is being ignored or protected. SDE-UI found the case on #576 - the
# design's own copy control is 26px at the mobile unit, under the 44px tap target ui-smoke
# enforces, so a FAITHFUL transcription broke a rule that lives outside the spec. CTO ruling.
# AND `shipped` MAY BE THE EMPTY STRING, WHICH IS A BODY RATHER THAN A MISSING FIELD. This was
# written when only ADDED and CHANGED were gated, so every declaration described a rule we ship and
# every body was non-empty. DROPPED became enforceable the day the transcription completed, and a
# rule the spec has and we ship NOWHERE declares the body "" - there is nothing else it could say.
# Requiring truthiness put the two gates in direct contradiction: parity-check compares the declared
# body against the shipped one, so "" is the only value that passes there, and any sentinel this
# check would have accepted reads as DECLARED WITH A DIFFERENT BODY. `is not None` keeps the intent
# whole: the field stays mandatory, and shipping the rule later still makes the declaration stale.
check "every declaration in every departures file carries all three halves, kind included" \
  "python3 -c \"import json,sys,glob; fs=glob.glob('$REPO/design/spec/*/departures.json'); sys.exit(1 if not fs else (1 if [k for f in fs for k,v in json.load(open(f)).items() if not k.startswith('_') and not (isinstance(v,dict) and v.get('why') and v.get('shipped') is not None and v.get('kind') in ('divergence','override'))] else 0))\""
check "and the checker refuses a declaration that does not name its kind, rather than defaulting" \
  "grep -qF 'UNKINDED DECLARATION' '$REPO/scripts/parity-check.mjs' && grep -qF 'means both means neither' '$REPO/scripts/parity-check.mjs'"
check "and every vendored spec has one beside it, so a slice cannot depart undeclared" \
  "python3 -c \"import sys,glob,os; specs=[d for d in glob.glob('$REPO/design/spec/*/') ]; sys.exit(0 if all(os.path.exists(d+'departures.json') for d in specs) else 1)\""
check "and the CI step runs a comparison for every vendored spec" \
  "[ \"\$(grep -c 'node scripts/parity-check.mjs design/spec/' '$CIWF')\" = \"\$(ls -d '$REPO'/design/spec/*/ | wc -l | tr -d ' ')\" ]"
check "and the check reports what the spec has and we DROPPED, not only what we added" \
  "grep -qF 'in the spec, not shipped' '$REPO/scripts/parity-check.mjs'"
check "a rule moved into a media query is not counted as parity" \
  "grep -qF 'context ?' '$REPO/scripts/parity-check.mjs' && grep -qF 'prelude.startsWith(\"@\")' '$REPO/scripts/parity-check.mjs'"

echo "== repo: the rollback decision and the reason strings it decides on"
# #607. redeploy.sh does not roll back when the faucet is unhealthy for a reason a rollback
# cannot fix, and it tells those apart by matching the app's own reason string with a literal
# glob. #604 shipped BOTH halves of that coupling in one commit - it renamed "node syncing" to
# "wallet re-scanning" in readiness.ts and widened the glob in the same breath - and left
# nothing holding them together afterwards. Measured on b501b51: rename one side only and
# npm test is 900/0, the redeploy suite is 183/0, and production emits a reason the glob does
# not match. A chain outage then rolls back a good image, which is the failure #228 added the
# reason string to prevent, arriving by a different door.
#
# This is the deploy-must-assert-its-own-outcome shape: both files are individually correct
# and the SYSTEM is wrong, so no suite that reads one file can see it.
RB="$REPO/deploy/z3/redeploy.sh"
RDY="$REPO/src/lib/readiness.ts"

# THE GLOB SIDE. Every literal inside a *"..."* case pattern, from every arm in the file, so
# a new arm is covered without being listed here - a list is what missed live-smoke.yml at
# the top of this suite.
RB_LITERALS="$(grep -oE '\*"[^"]+"\*' "$RB" | sed 's/^\*"//;s/"\*$//' | sort -u)"
# The multi-literal arms specifically: reason_is_not_the_code() carries the chain set, and
# the "NOT ROLLING BACK ... the cause is the CHAIN" log 380 lines later carries it AGAIN.
# Two copies of one decision, and updating one is the cheapest way to break this.
RB_CHAIN="$(grep -oE '\*"[^"]+"\*(\|\*"[^"]+"\*)+' "$RB" | sort -u)"
RB_CHAIN_SITES="$(grep -cE '\*"[^"]+"\*(\|\*"[^"]+"\*)+' "$RB")"
RB_LEGACY="$(sed -n 's/^[[:space:]]*#[[:space:]]*LEGACY-REASON:[[:space:]]*\(.*[^ ]\)[[:space:]]*--.*/\1/p' "$RB" | sort -u)"

check "redeploy.sh decides on reason strings at all, so the reader below has something to read" \
  '[ -n "$RB_LITERALS" ]'
# Written out rather than passed to check(): the expressions read the variables above, and
# inside a quoted check string shellcheck cannot see that use and calls them dead. Saying the
# counts in the failure is worth more than the one-liner anyway.
if [ "$RB_CHAIN_SITES" -ge 2 ]; then
  ok "the chain set is written at more than one call site"
else
  bad "the chain set is written at more than one call site (found $RB_CHAIN_SITES)"
fi
RB_CHAIN_DISTINCT="$(printf '%s\n' "$RB_CHAIN" | wc -l | tr -d ' ')"
if [ -n "$RB_CHAIN" ] && [ "$RB_CHAIN_DISTINCT" = "1" ]; then
  ok "and every call site globs on the SAME set, so one cannot be updated alone"
else
  bad "and every call site globs on the SAME set, so one cannot be updated alone ($RB_CHAIN_DISTINCT distinct pattern(s) across $RB_CHAIN_SITES site(s))"
fi

# THE APP SIDE, with comments removed, and that is the whole difficulty. The prose above the
# re-scanning return QUOTES the spelling it replaced - `This said "node syncing"` - so a plain
# grep of readiness.ts finds "node syncing" twice and reports a string as emitted because a
# paragraph mentions it. That is a false pass in the exact check written to prevent one. Only
# whole-line comments are stripped and the result is asserted to contain none, so a trailing
# comment fails loudly here instead of being read as code.
RDY_CODE="$(awk '/^export function readinessReason/,/^}/' "$RDY" | grep -vE '^[[:space:]]*(//|\*|/\*)')"
check "readinessReason() was found and it returns something" \
  '[ -n "$RDY_CODE" ] && printf "%s\n" "$RDY_CODE" | grep -q "return \""'
check "and no comment survived the strip, since the comments quote spellings that are gone" \
  '! printf "%s\n" "$RDY_CODE" | grep -q "//"'

# ONLY WHAT IS RETURNED, which is the difference between reading the function and reading
# the reasons. Reading every string in the body admits `=== "unsafe"` and the raw `if (...)`
# lines, and then a glob literal could be satisfied by a constant that is declared and never
# returned - the coupling broken, the row green. So: flattened, cut at statement boundaries,
# and only the text after a `return` survives. The ternary spans four lines and is one
# statement, which is why it is flattened first rather than read line by line.
#
# Then interpolation holes and string delimiters both become separators, so no chunk spans a
# hole: `node ${lag} blocks behind the network` must not be readable as "node blocks behind
# the network", a phrase the app never emits. What is left over is the ternary's own
# condition (`lag == null ?`), harmless, and bounded by the phrase assertion below.
RDY_EMITS="$(printf '%s\n' "$RDY_CODE" | tr '\n' ' ' | tr ';' '\n' \
  | grep 'return' | sed 's/.*return //' \
  | awk '{ gsub(/\$\{[^}]*\}/, "\n"); gsub(/["`]/, "\n"); print }')"
check "every literal the rollback decides on is a phrase, not a word this reader could find in code" \
  '! printf "%s\n" "$RB_LITERALS" | grep -qv " "'

RB_UNEMITTED=""
while IFS= read -r lit; do
  [ -n "$lit" ] || continue
  printf '%s\n' "$RDY_EMITS" | grep -qF "$lit" && continue
  printf '%s\n' "$RB_LEGACY" | grep -qxF "$lit" && continue
  RB_UNEMITTED="$RB_UNEMITTED [$lit]"
done <<EOF
$RB_LITERALS
EOF
if [ -z "$RB_UNEMITTED" ]; then
  ok "every string the rollback matches on is one readinessReason() still emits, or a declared LEGACY-REASON"
else
  bad "every string the rollback matches on is one readinessReason() still emits, or a declared LEGACY-REASON (matched by nothing:$RB_UNEMITTED)"
fi

# And the exception cannot outlive what it excepts. A LEGACY-REASON naming a literal the glob
# no longer carries is a note about a decision that has already been reversed, and it would
# silently license the next rename of that same string.
RB_STALE=""
while IFS= read -r lit; do
  [ -n "$lit" ] || continue
  printf '%s\n' "$RB_LITERALS" | grep -qxF "$lit" || RB_STALE="$RB_STALE [$lit]"
done <<EOF
$RB_LEGACY
EOF
if [ -z "$RB_STALE" ]; then
  ok "and every LEGACY-REASON declared is one the glob still carries"
else
  bad "and every LEGACY-REASON declared is one the glob still carries (declared, not globbed:$RB_STALE)"
fi

# THE EXCLUSION, which is the other half of the decision and is the one #596 ruled on by name:
# "wallet balance unknown" is the IMAGE's fault - a broken build really can fail to reach the
# wallet, and a rollback really does fix that - so it must keep falling through to the rollback.
# Widening the glob to *"wallet"* would swallow it along with the re-scanning reason and turn a
# recoverable outage into a page nobody can act on. Only this one is pinned: it is the only
# exclusion redeploy.sh states in so many words, and pinning the others would be asserting a
# decision nobody recorded. Matched the way the shell matches, from the literals just read.
RB_WRONG=""
RB_EXCLUDED="wallet balance unknown"
# AND THE STRING THIS ROW PROTECTS HAS TO BE ONE THE PRODUCT STILL SAYS. Found by SDE-UI reviewing
# this PR, and it is the defect this whole file is about, one layer up and inside the gate that
# fixes it: every GLOB literal is tied back to readinessReason() by the row above, and the one
# literal tied to nothing was the one written HERE. Their mutant survived at 236/0 - rename
# "wallet balance unknown" to "wallet balance unavailable" in readiness.ts and its test, then add
# *"balance unavailable"* to both chain arms, and the rollback starts treating a wallet-balance
# outage as not-the-code's-fault while this row reports the exclusion intact. Every other row is
# honestly green: it is still a phrase, readinessReason genuinely emits it, and both sites agree.
#
# This does NOT guess the new spelling, which is the point. It refuses to go vacuous in silence:
# the moment the product stops saying what RB_EXCLUDED says, the row below is protecting a string
# nothing emits and this one says so.
if printf '%s\n' "$RDY_EMITS" | grep -qF "$RB_EXCLUDED"; then
  ok "and that reason is one readinessReason() still emits, so a rename cannot quietly make the row below vacuous"
else
  bad "and that reason is one readinessReason() still emits, so a rename cannot quietly make the row below vacuous (nothing emits [$RB_EXCLUDED], so the exclusion row is protecting a string the app no longer says)"
fi
while IFS= read -r lit; do
  [ -n "$lit" ] || continue
  case "$RB_EXCLUDED" in *"$lit"*) RB_WRONG="$RB_WRONG [$RB_EXCLUDED <- $lit]" ;; esac
done <<EOF
$RB_LITERALS
EOF
if [ -z "$RB_WRONG" ]; then
  ok "and the reason #596 ruled IS the image's fault still falls through to a rollback"
else
  bad "and the reason #596 ruled IS the image's fault still falls through to a rollback (now swallowed:$RB_WRONG)"
fi

echo "== repo: the address env names the ui job sets, the smoke reads, and config actually consumes"
# #605's guard compares process.env[NAME] against what the page rendered. NAME is a string literal
# in scripts/ui-smoke.mjs, another in .github/workflows/ci.yml and a third in src/lib/config.ts, and
# nothing tied the three. Rename one consistently across the product and the guard reads an env
# nobody sets: `addrSet` is false, the row takes its NOT CHECKED branch, and it is GREEN while
# checking nothing - which is the precise failure #605 exists to stop, reintroduced by the guard
# written to stop it. SDE-UI's L38 found the same shape in #613's RB_EXCLUDED; this is that detector
# run over my other change rather than waiting to be told twice.
#
# config.ts is the authority because it is what the product actually reads. The other two are
# checked against it, never against each other.
CFG_ENVS="$(grep -oE 'process\.env\.FAUCET_[A-Z_]*ADDRESS' "$REPO/src/lib/config.ts" | sed 's/^process\.env\.//' | sort -u)"
check "config.ts reads address env vars at all, so the two readers below have something to agree with" \
  '[ -n "$CFG_ENVS" ]'

# The smoke's CODE, comments stripped: this file names these vars in prose constantly and a comment
# mentioning one is not the same as the guard reading it - the same trap the #607 reader has.
UIS_CODE="$(grep -vE '^[[:space:]]*(//|\*|/\*)' "$REPO/scripts/ui-smoke.mjs")"
UIS_ENVS="$(printf '%s\n' "$UIS_CODE" | grep -oE 'FAUCET_[A-Z_]*ADDRESS' | sort -u)"
# AN EMPTY SET ORPHANS NOTHING AND PASSES, which is this gate's own defect one turn further in
# (SDE-UI, L38 on this PR). I guarded CFG_ENVS against emptiness fifteen lines up and did not
# guard the other two: rename every FAUCET_*ADDRESS out of ui-smoke.mjs and UIS_ENVS comes back
# empty, the loop below never runs, and the row reports green - so deleting the #605 guard this
# PR exists to protect is invisible to the row protecting it. The detector's second question is
# the one that catches it: not just what a constant is the truth of, but what the reader does
# when it reads NOTHING.
check "the smoke guards on address envs at all, so an empty read cannot pass as agreement" \
  '[ -n "$UIS_ENVS" ]'
UIS_ORPHAN=""
while IFS= read -r n; do
  [ -n "$n" ] || continue
  printf '%s\n' "$CFG_ENVS" | grep -qxF "$n" || UIS_ORPHAN="$UIS_ORPHAN [$n]"
done <<EOF
$UIS_ENVS
EOF
if [ -z "$UIS_ORPHAN" ]; then
  ok "every address env the smoke guards on is one config.ts reads, so a rename cannot leave it inert"
else
  bad "every address env the smoke guards on is one config.ts reads, so a rename cannot leave it inert (config reads no such var:$UIS_ORPHAN)"
fi

# And the ui job's side: a name set in CI that the product does not read configures nothing, and the
# page then renders its not-configured card while ci.yml looks correct to a reader.
# THE RANGE HAS TO SKIP ITS OWN OPENING LINE. `/^  ui:/,/^  [a-z...]:$/` opens AND closes on
# `  ui:` itself, because the job header matches the end pattern too - the range yielded exactly
# one line, CI_ENVS was empty, and the orphan loop below never ran. The row was vacuous from the
# moment I wrote it, and the emptiness guard above is what surfaced it on its first run. Flagged
# rather than quietly corrected: this is the same defect the guard exists for, found by the guard,
# in the code that ships the guard.
CI_ENVS="$(awk '/^  ui:$/{f=1;next} f && /^  [a-z][a-z0-9-]*:$/{f=0} f' "$CIWF" | grep -oE '^ +FAUCET_[A-Z_]*ADDRESS' | tr -d ' ' | sort -u)"
# Same guard, same reason: the ui job going back to setting no address at all is exactly the
# state #605 closed, and an empty set would let it through this row in silence.
check "and the ui job sets address envs at all, so reverting #605 cannot pass as agreement" \
  '[ -n "$CI_ENVS" ]'
CI_ORPHAN=""
while IFS= read -r n; do
  [ -n "$n" ] || continue
  printf '%s\n' "$CFG_ENVS" | grep -qxF "$n" || CI_ORPHAN="$CI_ORPHAN [$n]"
done <<EOF
$CI_ENVS
EOF
if [ -z "$CI_ORPHAN" ]; then
  ok "and every address env the ui job sets is one config.ts reads, so CI cannot configure a variable nothing consumes"
else
  bad "and every address env the ui job sets is one config.ts reads, so CI cannot configure a variable nothing consumes (config reads no such var:$CI_ORPHAN)"
fi

echo "== repo: no unit test binds a fixed port, because a taken one reports a wrong value"
# #603. A unit test on a fixed port does not FAIL when the port is taken - it reports a WRONG
# VALUE. The spawn loses the bind, the test's own fetch reaches whoever IS listening, and the
# assertion fails with a plausible number from a stranger's double. On 2026-09-16 send.test.ts
# asserted 100000000n and got 1500000000n because another process held 28451; three people nearly
# published that red as a code defect. crosslinksend.test.ts bound 28611, which is ALSO ui-smoke's
# lightwalletd double, so a smoke run on the same box was enough to do it.
#
# TEST-SUPPORT CODE COUNTS, NOT JUST *.test.ts (SDE-Infra reviewing this PR). src/lib/testing/ is
# where a fixed port lands NEXT: a `PORT` default in a shared spawner is invisible to a scan of
# test files and re-creates the defect for every caller at once, which is worse than the three
# call sites this closes. The scan takes both.
#
# COMMENTS STRIPPED BEFORE READING, and that is not a detail. These files now DESCRIBE the ports
# they used to bind, in the comment explaining why they no longer do, so a naive grep reports the
# fix as the defect. Same trap as the #607 reader finding "node syncing" twice in prose.
# `while read`, not `for f in $(find ...)`: a path with a space would split into two and the row
# would read a file that does not exist, which is a pass. SC2044.
PORTED=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  n="$(grep -vE '^[[:space:]]*(//|\*|/\*)' "$f" | grep -cE '\b28[0-9]{3}\b' || true)"
  [ "$n" = "0" ] || PORTED="$PORTED [$(basename "$f"):$n]"
done <<EOF
$(find "$REPO/src" -name '*.test.ts' -o -path '*/testing/*' -name '*.ts' 2>/dev/null)
EOF
check "no unit test binds a literal 28xxx port in code, so a busy box cannot fake an assertion" \
  "[ -z '$PORTED' ]"

# AND THE SET IS NOT EMPTY. A find that matched nothing would satisfy the row above for free -
# every derived set this week has needed this and three of us have shipped one without it.
TESTFILES="$(find "$REPO/src" -name '*.test.ts' 2>/dev/null | wc -l | tr -d ' ')"
check "and there are unit tests to check at all, so the row above is not counting an empty set" \
  "[ $TESTFILES -gt 20 ]"

# The doubles have to report the port the KERNEL gave, or PORT=0 announces ":0" and a caller
# cannot find them. This is the half that makes the fix possible rather than the fix itself.
check "the doubles announce the port they are bound to, not the one they were asked for" \
  "grep -q 'srv.address().port' '$REPO/scripts/fake-zallet.mjs' && grep -q 'srv.address().port' '$REPO/scripts/fake-crosslink.mjs'"

echo "== repo: the runbook's commands can be run from where it says to run them"
# A RUNBOOK COMMAND THAT CANNOT WORK IS WORSE THAN A MISSING ONE, because the failure reads like a
# finding. On 2026-09-16 the owner followed this page twice and got two answers that looked like
# discoveries and were neither:
#   `cat /var/lib/faucet-watchdog/miner-parked-by-fork-heal` on a LAPTOP -> "No such file or
#     directory", identical to the answer from the box, and the page had no ssh line above it.
#   `cd .../deploy/z3 && docker compose restart faucet` -> "no configuration file provided: not
#     found", because that directory holds only docker-compose.faucet.yml.
#
# These rows tie the page to what is on disk. They cannot check that a command WORKS - only the box
# can - but they catch the two shapes that have actually bitten: a compose call in a directory with
# no default-named file, and an unresolved placeholder standing where a host should be.
# DOUBLE-QUOTED CHECK EXPRESSIONS, unlike most of this file. A count used ONLY inside a
# single-quoted `check` argument is invisible to shellcheck, which reports SC2034 "appears
# unused" and fails the shell job. The neighbours escape it because they also use their
# variable unquoted in a loop; these two do not. Expanding at definition is equivalent here -
# both are integers computed one line above.
OPS="$REPO/OPERATIONS.md"
check "OPERATIONS.md exists, so the rows below are reading something" '[ -s "$OPS" ]'

# deploy/z3 has no docker-compose.yml, so every invocation naming that directory needs -f. Counted
# rather than grepped for absence: `! grep -q` under pipefail is a false pass.
Z3_CALLS="$(grep -c 'zcash-faucet/deploy/z3 && docker compose' "$OPS" || true)"
Z3_NAKED="$(grep -n 'zcash-faucet/deploy/z3 && docker compose' "$OPS" | grep -vc 'compose -f docker-compose.faucet.yml' || true)"
# THE SET FIRST, THEN ITS VIOLATORS. An empty set has no violators: delete every one of these lines
# from the page and `grep -vc` counts zero non-matching lines out of zero, so the row below passes
# while guarding nothing. SDE-Infra's block on this PR, and it is the second question in L38 - not
# only what a constant is the truth of, but what the reader does when it reads NOTHING. I found
# this exact shape in their #620 this afternoon and then shipped it here.
check "the runbook still tells an operator how to restart the faucet at all" \
  "[ $Z3_CALLS -gt 0 ]"
check "every runbook compose call in deploy/z3 passes -f, because that directory has no default-named compose file" \
  "[ $Z3_NAKED -eq 0 ]"
check "and the file it names is the one that is actually there" \
  '[ -f "$REPO/deploy/z3/docker-compose.faucet.yml" ] && [ ! -f "$REPO/deploy/z3/docker-compose.yml" ] && [ ! -f "$REPO/deploy/z3/compose.yaml" ]'

# An unresolved placeholder is the same defect as a missing line: the reader supplies something and
# it is not checkable. <box> was the one that sent the owner to a laptop.
# ANY PLACEHOLDER SPELLING, not the one that happened to be there. SDE-UI: respell it root@<host>
# and a `grep -c 'root@<box>'` row passes while the page is exactly as useless. A denylist of the
# spellings I thought of cannot be complete - the same finding they blocked my #619 on, and I wrote
# this row after that.
PLACEHOLDER="$(grep -cE 'root@<[^>]*>' "$OPS" || true)"
check "the runbook names a real ssh host rather than an unresolved <box> placeholder" \
  "[ $PLACEHOLDER -eq 0 ]"

# ABSENCE OF A PLACEHOLDER IS NOT PRESENCE OF THE HOST, and the defect this PR opens with is the
# MISSING ssh line, not a wrong one. Without this the fix can be deleted and the gate stays green.
# Ordering matters as much as presence: the ssh line below the marker read is the same defect.
# INSIDE THE SAME BLOCK, not merely earlier in the file. SDE-UI's mutant: move the ssh line to an
# unrelated earlier section and delete it from the fork-park block, and a first-ssh-anywhere versus
# first-marker-anywhere comparison still passes - the two happen to be adjacent today, so the row is
# meaningful NOW and stops being so the moment the document is reorganised. The page is then back to
# telling an operator to sudo cat a box-only path with no instruction to get there, which is the
# defect this PR exists to close.
#
# So: find the marker read, walk BACK to the fence that opens its block, and require an ssh line
# between the two. A block is the unit an operator copies.
MARKER_CAT="$(grep -n 'cat /var/lib/faucet-watchdog/miner-parked-by-fork-heal' "$OPS" | head -1 | cut -d: -f1)"
BLOCK_TOP="$(head -n "${MARKER_CAT:-1}" "$OPS" | grep -n '^```' | tail -1 | cut -d: -f1)"
SSH_IN_BLOCK=0
if [ -n "$MARKER_CAT" ] && [ -n "$BLOCK_TOP" ]; then
  SSH_IN_BLOCK="$(sed -n "${BLOCK_TOP},${MARKER_CAT}p" "$OPS" | grep -c 'ssh root@' || true)"
fi
check "the fork-park block itself tells the operator to ssh to the box before reading a path that only exists there" \
  "[ -n '$MARKER_CAT' ] && [ $SSH_IN_BLOCK -gt 0 ]"

# NOT ADDING A MARKER-PATH ROW HERE. I wrote one and my own mutant refused it: renaming the
# watchdog's marker to `...-healing` left my `grep -q "miner-parked-by-fork-heal"` matching, because
# the new name CONTAINS the old one - a substring pass dressed as a check. The mutant killed
# :1337's row instead of mine, which is the tell. That row already ties the marker across the three
# files and does it by composing FORK_PARK_DIR with the basename rather than spelling the joined
# path, so it is both stricter and there first. A weaker duplicate beside it is noise that would
# read like coverage.

echo "== repo: no other workflow can impersonate a required CI job"
# #514 part 1. auto-deploy's ci_gate selects check-runs by `.name` with no workflow or check-suite
# filter and takes the NEWEST id per name, so a job in ANOTHER workflow sharing an id with a
# required CI job would override CI's verdict - and newer wins, which on a tip live-smoke keeps
# touching is always the impostor. Nothing collides today (live-smoke's only job is `probe`) and
# the gate cannot tell; this row keeps that true.
#
# THE SET EQUALITY IS ALREADY HELD ABOVE, at "the gate requires exactly the jobs ci.yml defines",
# and my first version of this re-asserted it with a WEAKER reader: `[a-z]` only, no tolerance for
# a trailing comment - which is precisely the first-cut bug the comment at :237 records having
# already been fixed once. Three of my four rows were redundant and one of them was a regression
# dressed as a check. GATE_JOBS and the awk below are reused from there rather than re-derived.
#
# SCANNED UNDER `jobs:` ONLY: a whole-file scan also matches the `on:` triggers, so `push` and
# `schedule` would read as job ids. I hit that enumerating the collision surface by hand.
CLASH=""
SCANNED=0
for wf in "$REPO"/.github/workflows/*.yml "$REPO"/.github/workflows/*.yaml; do
  [ -e "$wf" ] || continue
  case "$wf" in *ci.yml) continue ;; esac
  SCANNED=$((SCANNED + 1))
  for id in $(awk '/^jobs:/{injobs=1; next} injobs && /^  [A-Za-z_][A-Za-z0-9_-]*:[[:space:]]*(#.*)?$/ {sub(/^  /, ""); sub(/:.*$/, ""); print}' "$wf"); do
    for n in $GATE_JOBS; do
      [ "$id" = "$n" ] && CLASH="$CLASH [$(basename "$wf"):$id]"
    done
  done
done
if [ -z "$CLASH" ]; then
  ok "no other workflow declares a job id auto-deploy treats as CI's verdict"
else
  bad "no other workflow declares a job id auto-deploy treats as CI's verdict (the newer run would win:$CLASH)"
fi

# AND THE LOOP ABOVE ACTUALLY READ SOMETHING. With one workflow in the tree it never runs and
# reports agreement it never tested - the empty-set shape, which three of us shipped this week.
#
# COUNTED INSIDE THE LOOP, not by a second find() beside it, and the difference is the whole value
# of the row (SDE-UI, review of #634). Derived separately, the two cannot contradict each other for
# the reason that actually happens: the glob stops matching - the directory is renamed, the
# workflows move, someone writes `workflow/` - and `find` on its own hard-coded path still says
# "1 other workflow" while the loop reads nothing. Both rows green, nothing checked. Sharing the
# traversal means the only way the partner can be green is that the loop really walked a file.
check "and the loop above actually read a workflow, so it is not reporting agreement on an empty set" \
  "[ $SCANNED -ge 1 ]"

echo "== repo: the merge queue can actually run, rather than merely being switched on"
# A MERGE QUEUE THAT CANNOT REPORT ITS REQUIRED CHECKS HOLDS EVERY PR FOREVER, and it fails in
# the shape of CI being slow rather than of anything being broken. main requires app, miner,
# smoke and shell; a queued PR is tested on a `merge_group` ref; a workflow that does not listen
# for that event never reports those four there.
#
# These rows are the PRECONDITION for the branch-protection flip, and they are in the repo so the
# flip cannot be re-done later against a ci.yml that has lost the trigger.
check "ci.yml listens for merge_group, without which a queue never gets its required checks" \
  "grep -qE '^  merge_group:' '$CIWF'"

# AND THE HALF THAT IS EASY TO MISS: a cancelled run reports NO conclusion, so a cancellable
# queue entry can sit waiting for a check that was killed. The old predicate was
# `event_name != 'push'`, which is TRUE for merge_group. Asserted as the positive spelling
# rather than as the absence of the old one, because a third spelling would pass an absence test.
check "and a queue run is not cancellable, so a killed run cannot strand an entry" \
  "grep -qF \"cancel-in-progress: \\\${{ github.event_name == 'pull_request' }}\" '$CIWF'"

# The four REQUIRED contexts must be jobs that exist. A queue waits on the names branch
# protection asks for, not on whatever the workflow happens to define.
MQ_MISSING=""
for j in app miner smoke shell; do
  grep -qE "^  ${j}:" "$CIWF" || MQ_MISSING="$MQ_MISSING [$j]"
done
check "and every context main requires is a job this workflow defines" \
  "[ -z '$MQ_MISSING' ]"

# DEFINED IS NOT THE SAME AS REPORTS, and SDE-UI blocked this PR on exactly that gap. A required
# job carrying `if: github.event_name != 'merge_group'` is still defined, still named, and SKIPS
# on the queue - and a skipped job reports no conclusion, so the entry waits forever. Measured by
# them: adding that condition to `smoke` left the suite at 256/0, which is the outage this PR's
# own body describes, invisible to the row above.
#
# So: no required job may carry a job-level `if:` at all. That is stricter than the failure needs
# and deliberately so - a conditional whose expression happens to be true today is a row nobody
# re-verifies, and the four contexts main blocks on are not the place for cleverness.
MQ_COND=""
for j in app miner smoke shell; do
  body="$(awk -v j="  $j:" '$0==j{f=1;next} f&&/^  [a-z][a-z0-9-]*:$/{f=0} f' "$CIWF")"
  printf '%s\n' "$body" | grep -qE '^    if:' && MQ_COND="$MQ_COND [$j]"
done
check "and no required job is conditional, because a SKIPPED job reports nothing and strands the queue" \
  "[ -z '$MQ_COND' ]"


echo "== repo: every timer and socket the repo ships is declared in enabled-units, or deliberately absent by name"
# faucet-feedback-drain.timer shipped on 2026-09-18 without a line in enabled-units. Nothing
# was wrong with the unit, the script, or the install: the box did exactly what the repo said,
# which was nothing, and the owner's messages sat queued for three days. This is the row that
# goes red on that PR. A timer or socket is a unit nothing else starts, so "shipped and not
# declared" has one meaning: it will never run. A service can be behind a timer or a template
# and is judged by the enablement rule in the file, not here.
UNDECLARED_ARMING=""
ENABLED_UNITS_DECL="$(sed 's/#.*//; s/[[:space:]]//g' "$REPO/deploy/z3/enabled-units")"
ABSENT_BLOCK="$(awk '/^# DELIBERATELY ABSENT/{f=1} f' "$REPO/deploy/z3/enabled-units")"
for f in "$REPO"/deploy/z3/*.timer "$REPO"/deploy/z3/*.socket; do
  [ -e "$f" ] || continue
  u="$(basename "$f")"
  printf '%s\n' "$ENABLED_UNITS_DECL" | grep -qxF -- "$u" && continue
  printf '%s\n' "$ABSENT_BLOCK" | grep -qF -- "$u" && continue
  UNDECLARED_ARMING="$UNDECLARED_ARMING $u"
done
check "the declaration was actually read, so an empty list cannot pass this row" \
  "[ \"\$(printf '%s\n' \"\$ENABLED_UNITS_DECL\" | grep -c '\.timer$')\" -ge 5 ]"
check "no shipped timer or socket is missing from enabled-units without being named as deliberately absent:$UNDECLARED_ARMING" \
  "[ -z '$UNDECLARED_ARMING' ]"
check "and the feedback drain timer is one of the declared ones, by name" \
  "printf '%s\n' '$ENABLED_UNITS_DECL' | grep -qxF faucet-feedback-drain.timer"

echo "== repo: every env key the app reads is declared in faucet.env.example, judged by the audit's own check"
# audit-drift.sh's env-completeness half runs on the box nightly and said "FAUCET_WALLET_MAX_LAG_BLOCKS
# is read by the app but declared nowhere" for a fortnight to a page nobody could read (#721). The
# check needs only src/ and the example, so it runs here too, on the PR that adds the read - with the
# audit's own regexes, not a copy of them that can drift. Units and docker are unavailable on a runner,
# so the audit exits 2 (unverified) by design; the row reads the one finding it is about.
# EVERY AUDIT_ KNOB SET, not just the two that matter here: drift.sh runs before this suite in
# CI order and exports AUDIT_OVERLAY_DIR and friends to its fixture, and a row that inherits
# them audits a fixture example with no keys and reports every key the app reads as
# undeclared. Red on the PR that added this row, green when run alone - the suite-order leak
# this harness has paid for before.
AUDIT_ENV_OUT="$(AUDIT_REPO_DIR="$REPO" AUDIT_OVERLAY_DIR="$REPO/deploy/z3" AUDIT_UNIT_DIR=/nonexistent \
  AUDIT_INSTALL_DIR=/nonexistent AUDIT_ENV_DIR=/nonexistent AUDIT_VERSIONS_FILE="$REPO/deploy/z3/stack-versions.env" \
  AUDIT_ENABLED_UNITS_FILE="$REPO/deploy/z3/enabled-units" AUDIT_SYSTEMCTL=/nonexistent AUDIT_DOCKER=/nonexistent \
  bash "$REPO/deploy/z3/audit-drift.sh" --verbose 2>&1)"
check "the env-completeness check actually ran, so an empty finding list means something" \
  "printf '%s\n' \"\$AUDIT_ENV_OUT\" | grep -q 'env completeness (app reads vs deployment declares)' \
   && ! printf '%s\n' \"\$AUDIT_ENV_OUT\" | grep -qE 'cannot list what the app reads|scan failed|cannot tell what the deployment declares'"
UNDECLARED_READS="$(printf '%s\n' "$AUDIT_ENV_OUT" | grep -oE '[A-Z_][A-Z0-9_]* is read by the app but declared nowhere' | cut -d' ' -f1 | tr '\n' ' ')"
check "and no key the app reads is undeclared:${UNDECLARED_READS:+ $UNDECLARED_READS}" \
  "[ -z '$UNDECLARED_READS' ]"
check "and the wallet-lag ceiling is one of the declared ones, by name" \
  "grep -qE '^FAUCET_WALLET_MAX_LAG_BLOCKS=10$' '$REPO/deploy/z3/faucet.env.example'"
