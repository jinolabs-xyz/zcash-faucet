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
  "grep -q 'live-probe.mjs' '$T/probe-step.sh' && ! grep -q 'live-probe.mjs' '$T/page-step.sh' && grep -q 'gh run list' '$T/page-step.sh'"

# THE ENV BLOCK IS PART OF THE STEP. Extracting only `run:` left the mapping invisible:
# renaming the secret to FAUCET_ALERT_URL_TYPO turned every outage into "cannot page
# (email only)", green, and no check moved.
check "the probe step is handed the URL, the hatch and the off switch" \
  "grep -q 'SMOKE_URL: ..{ vars.FAUCET_LIVE_URL }' '$T/probe-step.yml' && grep -q 'SMOKE_ALLOW_UNREADY: ..{ vars.FAUCET_LIVE_ALLOW_UNREADY }' '$T/probe-step.yml' && grep -q 'SMOKE_DISABLED: ..{ vars.FAUCET_LIVE_SMOKE_DISABLED }' '$T/probe-step.yml'"
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
( cd "$REPO" && PATH="$T/nodebin:$BASE_PATH" SMOKE_URL="HTTPS://faucet.example.org" SMOKE_DISABLED="" \
    bash "$T/probe-step.sh" > "$T/upper.log" 2>&1 )
rc=$?
check "an uppercase HTTPS:// is accepted, because new URL() normalises it and a refusal pages" \
  "[ $rc -eq 0 ] && ! grep -q 'which is not https' '$T/upper.log'"
check "and the step really got past the scheme check, rather than exiting before it" \
  "grep -q 'stub node ran' '$T/upper.log'"
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
( cd "$REPO" && SMOKE_URL="" SMOKE_DISABLED="" bash "$T/probe-step.sh" > "$T/nourl.log" 2>&1 )
rc=$?
# Not just non-zero: bash exits 127 for a script that does not exist, so an extractor
# that wrote nothing would have satisfied `-ne 0` while proving nothing ran.
check "an unset FAUCET_LIVE_URL FAILS the step, rather than skipping green" "[ $rc -ne 0 ] && [ $rc -ne 127 ]"
check "and says what it has been doing" "grep -q 'probed NOTHING' '$T/nourl.log'"
( cd "$REPO" && SMOKE_URL="" SMOKE_DISABLED="1" bash "$T/probe-step.sh" > "$T/off1.log" 2>&1 )
check "the named off switch exits 0 with no URL" "[ $? -eq 0 ] && grep -q 'deliberately off' '$T/off1.log'"
( cd "$REPO" && SMOKE_URL="https://example.invalid" SMOKE_DISABLED="1" bash "$T/probe-step.sh" > "$T/off2.log" 2>&1 )
check "and ALSO with a URL set, which is when a maintenance window needs it" "[ $? -eq 0 ] && grep -q 'deliberately off' '$T/off2.log'"
# Caddy 308s :80 to :443 and fetch follows redirects, so an http origin passes every
# faucet check while the certificate check is skipped: off-box TLS monitoring absent for
# ever behind a green run, from one mistyped variable.
( cd "$REPO" && SMOKE_URL="http://faucet.example.org" SMOKE_DISABLED="" bash "$T/probe-step.sh" > "$T/http.log" 2>&1 )
check "an http FAUCET_LIVE_URL FAILS the step rather than skipping the certificate check" \
  "[ $? -ne 0 ] && grep -q 'which is not https' '$T/http.log'"

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
chmod +x "$T/bin/gh" "$T/bin/curl"
export STUB_CURL_LOG="$T/curl.log" STUB_GH_LOG="$T/gh.log"
# $1 = the run LIST the API would return, newest first; the workflow's own --jq picks
# from it, so the selection itself is under test.
page_run() {
  : > "$STUB_CURL_LOG"; : > "$STUB_GH_LOG"
  printf '%s' "$1" > "$T/prev.json"
  ( cd "$REPO" && PATH="$T/bin:$BASE_PATH" STUB_PREV_JSON="$T/prev.json" STUB_GH_LOG="$STUB_GH_LOG" \
      ALERT_URL="https://hook.example/x" ALERT_FORMAT="" GH_TOKEN=x SMOKE_URL="https://f.example" \
      PROBE_OUTCOME="${PAGE_PROBE_OUTCOME:-failure}" \
      GITHUB_RUN_ID=999 GITHUB_SERVER_URL=https://github.com GITHUB_REPOSITORY=o/r \
      bash "$T/page-step.sh" > "$T/page.log" 2>&1 )
}
old="$(date -u -d '-300 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-300M +%Y-%m-%dT%H:%M:%SZ)"
recent="$(date -u -d '-10 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)"
# The negatives need a control: "no curl" is also what a step that never ran looks like,
# and this suite has been bitten by exactly that (a missing python3 made three checks
# pass while nothing executed). Each asserts the step ran AND said why it held back.
page_run "[{\"conclusion\":\"success\",\"databaseId\":1,\"createdAt\":\"$old\"}]"
check "a previous SUCCESS does not page: one red run is a blip" \
  "! grep -q 'curl ' '$STUB_CURL_LOG' && grep -q 'first failure: not paging yet' '$T/page.log'"
page_run "[{\"conclusion\":\"failure\",\"databaseId\":1,\"createdAt\":\"$recent\"}]"
check "two failures only 10 minutes apart do not page: the rule is 30 MINUTES, not two runs" \
  "! grep -q 'curl ' '$STUB_CURL_LOG' && grep -q 'only 10 minutes apart' '$T/page.log'"
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
PAGE_PROBE_OUTCOME=cancelled page_run "[{\"conclusion\":\"success\",\"databaseId\":1,\"createdAt\":\"$old\"}]"
check "a run cut off after a SUCCESS does not page: a person cancelling one run is not an outage" \
  "! grep -q 'curl ' '$STUB_CURL_LOG' && grep -q 'first failure: not paging yet' '$T/page.log'"
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
check "the probe has tests, and npm test runs them" \
  "[ -f '$REPO/scripts/live-probe.test.mjs' ] && grep -q 'scripts/\*\*/\*.test.mjs' '$REPO/package.json'"
