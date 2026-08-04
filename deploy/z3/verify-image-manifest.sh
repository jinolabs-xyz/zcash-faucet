#!/usr/bin/env bash
# DOES THIS IMAGE ACTUALLY CONTAIN THIS COMMIT? (#377)
#
# WHY THIS EXISTS. A deploy reported SUCCESS while shipping a cached COPY layer that
# ignored the committed .dockerignore. The secrets fix merged, deployed green, and changed
# nothing in the running image. Nothing we had could see it: every check we own asks
# whether the build COMMAND succeeded, and a cached layer makes "the build succeeded" and
# "the image is right" two different answers. buildCommit cannot catch it either, because
# it is a build ARG and updates even when the layer beneath it does not.
#
# So this verifies the ARTEFACT, not the build.
#
# THE DESIGN POINT THAT DECIDES WHETHER THIS WORKS AT ALL: it compares CONTENT, not
# names. A cached COPY layer has exactly the right filenames and stale contents inside
# them. A manifest of paths would match perfectly and report success on the precise bug
# this was written for. Every path is hashed on both sides.
#
# BOTH DIRECTIONS, because a cached layer fails two ways and an absence-only scan passes
# one of them:
#   STALE    the path is present with content that is not the commit's
#   MISSING  the commit has it and the image does not
#   EXTRA    is deliberately NOT an error here. The image legitimately contains things the
#            commit does not (node_modules, .next, the runtime). Secret-pattern scanning
#            is a separate, weaker check; this one is the equality half.
#
# EXIT CODES, the same 0/1/2 vocabulary as redeploy.sh and bring-to-spec.sh, because the
# caller should not have to translate:
#   0  MATCHES            every compared path is byte-identical to the commit
#   1  DIFFERS            at least one is stale or missing, and they are NAMED
#   2  COULD-NOT-COMPARE  we could not read the image, resolve the commit, or find docker
#
# Two is not a softer one. A comparison that did not happen must never roll back a healthy
# deploy and must never report success. SDE-Infra set that requirement and it is the
# reason this returns three states rather than a boolean: a boolean forces the caller to
# invent the third, which is where it would be wrong.
#
# WHERE THIS BELONGS, and it is not symmetric. REDEPLOY IS THE GATE. CI IS EARLY WARNING
# AND ITS PASS IS NOT EVIDENCE ABOUT THE BOX. A CI runner starts with no layer cache, so a
# CI build of the very commit whose box image was stale would have produced a correct image
# and passed. A CI-only check hands you a green that specifically cannot see this failure.
# Do not let a green CI run be cited as proof the box is clean; that is the mistake #377
# already made once.
#
# NEVER STARTS THE CONTAINER. `docker create` makes one without running it and `docker
# export` reads its filesystem. A container that will not start is exactly when you most
# want to know what is inside the image, so running it cannot be a precondition of
# inspecting it.
set -uo pipefail

IMAGE="${1:-${VERIFY_IMAGE:-zcash-faucet:latest}}"
REPO_DIR="${VERIFY_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
APP_DIR="${VERIFY_APP_DIR:-app}"   # where the Dockerfile puts the source, no leading slash
DOCKER="${VERIFY_DOCKER:-docker}"

log() { echo "$(date -u +%FT%TZ) verify-image-manifest: $*"; }
# The suite's dependency guard names sha256sum (GNU coreutils) and notes macOS ships
# shasum instead, so accept either rather than being unrunnable on one of them.
if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum | cut -d" " -f1; }
elif command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 | cut -d" " -f1; }
else sha() { return 1; }
fi
cannot() { log "CANNOT COMPARE: $*"; log "  Not treating this as a failed deploy and not treating it as a pass."; exit 2; }

# ── what the commit says should be in there ──────────────────────────────────────
# Tracked files only, and then filtered by the SAME .dockerignore the build uses, because
# a file the build was told to exclude is not expected in the image and demanding it would
# make every clean image fail.
#
# Read from the repo rather than restated, for the reason the port checker gives: a copy
# drifts, and a drifted copy reports a match against a rule nobody is applying.
expected_manifest() {
  local f
  git -C "$REPO_DIR" ls-files -z 2>/dev/null | while IFS= read -r -d '' f; do
    dockerignored "$f" && continue
    # HEAD's content, not the worktree's. The question is whether the image matches the
    # COMMIT; a dirty worktree is a different question that redeploy already reports.
    printf '%s  %s\n' "$(git -C "$REPO_DIR" show "HEAD:$f" 2>/dev/null | sha)" "$f"
  done
}

# Docker's matching rules, and the one that already cost us a shipped fix: `*` DOES NOT
# CROSS A `/`. So `*.env` matches `foo.env` at the context root and never
# `deploy/z3/faucet.env`. #369 added six patterns on the wrong assumption and excluded
# nothing; #376 caught it. Implemented with bash pattern matching per path SEGMENT so the
# same mistake cannot be made here.
dockerignored() {
  local path="$1" pat base ig=1 negate matched
  [ -f "$REPO_DIR/.dockerignore" ] || return 1
  # LAST MATCH WINS, which is why this cannot return on the first hit. Docker evaluates
  # every pattern in order and a later `!` line un-ignores what an earlier one excluded,
  # so `*.md` followed by `!README.md` includes README.md. The first version of this
  # returned early and ignored `!` entirely, which would have dropped a negated file from
  # the expected set while Docker put it in the image: a file present and never verified.
  # Found while reviewing the CTO's #381, which uses `!**/faucet.env.example`, not by
  # rereading my own code - I had looked at this function three times and never asked
  # what it does with a bang.
  while IFS= read -r pat; do
    pat="${pat%%#*}"; pat="${pat#"${pat%%[![:space:]]*}"}"; pat="${pat%"${pat##*[![:space:]]}"}"
    [ -z "$pat" ] && continue
    negate=0
    case "$pat" in "!"*) negate=1; pat="${pat#!}" ;; esac
    [ -z "$pat" ] && continue
    matched=0
    # shellcheck disable=SC2254
    case "$pat" in
      # A leading **/ means "at any depth", the form #376 had to introduce.
      "**/"*) base="${pat#**/}"
              # shellcheck disable=SC2254
              case "${path##*/}" in $base) matched=1 ;; esac ;;
      # Anything else is anchored at the context root and its * stops at a /.
      *) case "$path" in $pat) matched=1 ;; esac
         # A bare directory name excludes everything under it.
         case "$path" in "$pat"/*) matched=1 ;; esac ;;
    esac
    [ "$matched" = 1 ] && { [ "$negate" = 1 ] && ig=1 || ig=0; }
  done < "$REPO_DIR/.dockerignore"
  return "$ig"
}

# ── what the image actually contains ─────────────────────────────────────────────
# One export, streamed, hashing only the paths we care about. `docker cp` per file would
# be hundreds of round trips; extracting the whole tar to disk would need image-sized
# scratch space on a box we already filled once.
image_manifest() {
  local cid="$1" tar="$2"
  "$DOCKER" export "$cid" > "$tar" 2>/dev/null || return 1
  # tar member paths have no leading slash: app/src/... for /app/src/...
  return 0
}

# PRESENCE AND CONTENT ARE ASKED SEPARATELY, and the first version of this got it wrong in
# a way worth keeping a note about. It piped `tar -xO` straight into the hasher, so a path
# that was ABSENT produced no bytes, the hasher hashed nothing, and it came back as the
# sha256 of the empty string. An absent file was therefore reported as STALE rather than
# MISSING: an absence converted into a value at the boundary, which is the same mistake as
# `balance ?? 0` and the ledger's old `txid ?? ""`, made by me while writing the check whose
# whole job is not doing that.
#
# The distinction is not cosmetic. STALE sends an operator to the layer cache; MISSING sends
# them to the COPY instruction or the .dockerignore. Different fixes.
in_tar() { tar -tf "$1" "$APP_DIR/$2" >/dev/null 2>&1; }

# Streamed rather than captured in $(...), which strips trailing newlines and would change
# the hash of every file that ends in one.
hash_in_tar() { tar -xOf "$1" "$APP_DIR/$2" 2>/dev/null | sha; }

# A pre-made tar may be supplied instead of an image, which is how the suite exercises the
# comparison with no docker present. The same seam CTAZ_LISTEN_CMD gives the port checker:
# the logic under test is the comparison, and requiring a daemon to reach it would mean the
# logic went untested and only the plumbing did.
PRESET_TAR="${VERIFY_TAR:-}"
if [ -z "$PRESET_TAR" ]; then
  command -v "$DOCKER" >/dev/null 2>&1 || cannot "no $DOCKER on this host"
fi
git -C "$REPO_DIR" rev-parse --verify HEAD >/dev/null 2>&1 || cannot "cannot resolve HEAD in $REPO_DIR"
[ -n "$PRESET_TAR" ] || "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 || cannot "image $IMAGE is not present locally"

EXPECTED="$(expected_manifest)"
# A read that returned nothing is a broken read, never a clean bill of health. Same guard
# as the port checker's per-source assertion: reporting a match on an empty comparison set
# would be the loudest possible false pass, and it is the easy mistake here.
EXPECTED_N="$(printf '%s\n' "$EXPECTED" | grep -c '[0-9a-f]' || true)"
[ "${EXPECTED_N:-0}" -ge 1 ] || cannot "derived 0 expected files from the commit, so there is nothing to compare"

if [ -n "$PRESET_TAR" ]; then
  [ -r "$PRESET_TAR" ] || cannot "the supplied tar $PRESET_TAR is not readable"
  TARBALL="$PRESET_TAR"
  CID=""
else
  CID="$("$DOCKER" create "$IMAGE" /bin/true 2>/dev/null)" || cannot "could not create a container from $IMAGE"
  TARBALL="$(mktemp)"
  cleanup() { [ -n "$CID" ] && "$DOCKER" rm -f "$CID" >/dev/null 2>&1 || true; rm -f "$TARBALL"; }
  trap cleanup EXIT
  image_manifest "$CID" "$TARBALL" || cannot "could not export the filesystem of $IMAGE"
fi

STALE=""; MISSING=""; SAME=0
while read -r want path; do
  [ -n "$path" ] || continue
  if ! in_tar "$TARBALL" "$path"; then
    MISSING="$MISSING $path"
    continue
  fi
  got="$(hash_in_tar "$TARBALL" "$path")"
  if [ "$got" != "$want" ]; then
    STALE="$STALE $path"
  else
    SAME=$((SAME + 1))
  fi
done <<< "$EXPECTED"

log "compared $EXPECTED_N tracked file(s) from $(git -C "$REPO_DIR" rev-parse --short HEAD) against $IMAGE"

if [ -n "$STALE" ] || [ -n "$MISSING" ]; then
  log "IMAGE DOES NOT MATCH THE COMMIT."
  [ -n "$STALE" ]   && { log "  STALE, present with the wrong content (a cached layer looks exactly like this):"; for p in $STALE; do log "    $p"; done; }
  [ -n "$MISSING" ] && { log "  MISSING, in the commit and not in the image:"; for p in $MISSING; do log "    $p"; done; }
  log "  $SAME file(s) did match. A rebuild with --no-cache is the usual fix."
  exit 1
fi

log "MATCHES: all $SAME compared file(s) are byte-identical to the commit"
exit 0
