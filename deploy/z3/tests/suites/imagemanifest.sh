# shellcheck shell=bash
# verify-image-manifest.sh (#377): does the image actually contain the commit?
#
# A deploy reported SUCCESS while shipping a cached COPY layer that ignored the committed
# .dockerignore. Every check we owned asked whether the build COMMAND succeeded, and a
# cached layer makes that a different question from whether the image is right.
#
# NO DOCKER IS NEEDED HERE, and that is deliberate rather than a compromise. The logic
# under test is the comparison; requiring a daemon to reach it would mean only the plumbing
# got tested. VERIFY_TAR supplies a fixture filesystem, the same seam CTAZ_LISTEN_CMD gives
# the port checker.

VIM="$REPO/deploy/z3/verify-image-manifest.sh"

vim_env() {
  T="$(mktemp -d)"
  R="$T/repo"
  mkdir -p "$R/src" "$R/deploy/z3"
  printf '.git\nnode_modules\n*.md\n**/*.env\n' > "$R/.dockerignore"
  printf 'export const A = 1;\n' > "$R/src/a.ts"
  printf 'export const B = 2;\n' > "$R/src/b.ts"
  printf 'secret=1\n'            > "$R/deploy/z3/faucet.env"
  printf '# doc\n'               > "$R/README.md"
  ( cd "$R" && git init -q . && git add -A \
      && git -c user.email=t@t -c user.name=t commit -q -m fixture )
}

# Build a fixture "image" filesystem. Faithful by default: it contains what a real COPY . .
# would put there, including .dockerignore itself, which Docker does copy.
vim_image() {
  rm -rf "$T/img"; mkdir -p "$T/img/app/src"
  cp "$R/src/a.ts" "$R/src/b.ts" "$T/img/app/src/"
  cp "$R/.dockerignore" "$T/img/app/"
  case "${1:-clean}" in
    stale)   printf 'export const A = 999;\n' > "$T/img/app/src/a.ts" ;;
    missing) rm -f "$T/img/app/src/b.ts" ;;
    empty)   : > "$T/img/app/src/b.ts" ;;
    secret)  mkdir -p "$T/img/app/deploy/z3"; cp "$R/deploy/z3/faucet.env" "$T/img/app/deploy/z3/" ;;
  esac
  ( cd "$T/img" && tar -cf "$T/img.tar" app )
}

vim_run() { VERIFY_REPO_DIR="$R" VERIFY_TAR="$T/img.tar" bash "$VIM" > "$T/out" 2>&1; echo $?; }

echo "== verify-image-manifest: an image that matches the commit passes"
vim_env; vim_image clean
check "a matching image exits 0" "[ \"\$(vim_run)\" = '0' ]"
check "and says so" "grep -q 'MATCHES' '$T/out'"

echo "== verify-image-manifest: A CACHED LAYER has the right NAMES and stale CONTENT"
# THE CASE THIS EXISTS FOR, and the reason it hashes rather than listing paths. A manifest
# of filenames matches a cached layer perfectly and reports success on the exact bug.
vim_env; vim_image stale
check "a stale layer exits 1, not 0" "[ \"\$(vim_run)\" = '1' ]"
check "and NAMES the stale path" "grep -q 'src/a.ts' '$T/out'"
check "and calls it stale rather than missing" "grep -q 'STALE' '$T/out'"
check "and does not claim a match" "! grep -q 'MATCHES' '$T/out'"

echo "== verify-image-manifest: the MIRROR failure, a layer missing a file the commit has"
# An absence-only secret scan passes this completely. It is the half nobody had.
vim_env; vim_image missing
check "a missing file exits 1" "[ \"\$(vim_run)\" = '1' ]"
check "and is reported as MISSING, not stale" \
  "grep -q 'MISSING' '$T/out' && grep -q 'src/b.ts' '$T/out'"

echo "== verify-image-manifest: PRESENT-BUT-EMPTY is stale, not missing"
# My first version piped `tar -xO` into the hasher, so an absent path produced no bytes and
# came back as the sha256 of the empty string. An absence became a value at the boundary and
# missing files reported as stale. Presence and content are asked separately now, and this
# pins the distinction: STALE sends you to the layer cache, MISSING to the COPY or the
# .dockerignore. Different fixes, so they must not collapse.
vim_env; vim_image empty
check "an empty file present in the image is STALE" \
  "[ \"\$(vim_run)\" = '1' ] && grep -q 'STALE' '$T/out'"
check "and is NOT reported as missing" "! grep -q 'MISSING' '$T/out'"

echo "== verify-image-manifest: dockerignored files are not expected, and * does not cross /"
# #369 shipped six patterns on the assumption that * crosses a /. It does not, which is why
# *.env never matched deploy/z3/faucet.env. This asserts the **/ form works AND that a
# secret sitting in the image does not fail the equality check, because absence scanning is
# a separate, weaker job than this one.
vim_env; vim_image secret
check "an excluded file present in the image does not fail the equality check" \
  "[ \"\$(vim_run)\" = '0' ]"
check "and the excluded paths were never demanded of the image" \
  "! grep -q 'faucet.env' '$T/out' && ! grep -q 'README.md' '$T/out'"

echo "== verify-image-manifest: an unreadable image is CANNOT-COMPARE, never a failure"
# 2 is not a softer 1. A comparison that did not happen must not roll back a healthy deploy
# and must not report success. SDE-Infra set this requirement.
vim_env; vim_image clean
out=$(VERIFY_REPO_DIR="$R" VERIFY_TAR="$T/nope.tar" bash "$VIM" 2>&1; echo "rc=$?")
check "an unreadable tar exits exactly 2" "echo '$out' | grep -q 'rc=2'"
check "and says it could not compare" "echo '$out' | grep -q 'CANNOT COMPARE'"
check "and refuses to call it either outcome" \
  "echo '$out' | grep -q 'not treating this as a failed deploy' || echo '$out' | grep -q 'Not treating'"

echo "== verify-image-manifest: no resolvable commit is cannot-compare, not a match"
T="$(mktemp -d)"; R="$T/norepo"; mkdir -p "$R"; : > "$T/img.tar"
check "no git repo exits 2 rather than claiming a match" "[ \"\$(vim_run)\" = '2' ]"

echo "== verify-image-manifest: an EMPTY EXPECTED SET is cannot-compare, not a match"
# THE LOUDEST POSSIBLE FALSE PASS: comparing nothing and reporting a match.
#
# My first version of this case built a directory with no git repo, which is caught by the
# HEAD guard several lines earlier. So it asserted the empty-set guard while exercising a
# different one, and removing the empty-set guard entirely left the suite green. Found by
# sabotage, and it is the same premise failure I criticised in #332: the comment named the
# dangerous shape and the fixture tested an easier one.
#
# This fixture has a WORKING repo with a real HEAD whose every tracked file is
# dockerignored, so the expected set is empty for the one reason the guard exists to catch,
# and no earlier check can intercept it.
T="$(mktemp -d)"; R="$T/allignored"; mkdir -p "$R"
printf '*.md\n' > "$R/.dockerignore.tmp"
printf '# only doc\n' > "$R/README.md"
mv "$R/.dockerignore.tmp" "$R/.dockerignore"
printf '.dockerignore\n*.md\n' > "$R/.dockerignore"
( cd "$R" && git init -q . && git add -A \
    && git -c user.email=t@t -c user.name=t commit -q -m allignored )
rm -rf "$T/img"; mkdir -p "$T/img/app"; ( cd "$T/img" && tar -cf "$T/img.tar" app )
check "a repo whose every tracked file is excluded exits 2, never 0" \
  "[ \"\$(vim_run)\" = '2' ]"
check "and says there was nothing to compare" \
  "grep -q 'nothing to compare' '$T/out'"

echo "== verify-image-manifest: a ! negation un-ignores, because LAST MATCH WINS"
# Docker evaluates every pattern in order and a later `!` line re-includes what an earlier
# one excluded. The first version of dockerignored() returned on the first match and did
# not understand `!` at all, so a negated file was dropped from the expected set while
# Docker put it in the image: present and never verified. Found reviewing #381, which uses
# !**/faucet.env.example.
vim_env
printf '*.md\n!README.md\n' > "$R/.dockerignore"
printf '# keep me\n' > "$R/README.md"
printf '# drop me\n' > "$R/NOTES.md"
( cd "$R" && git add -A && git -c user.email=t@t -c user.name=t commit -q -m negation )
# An image carrying README.md (Docker would copy it) and not NOTES.md (excluded).
# Everything the commit has that this .dockerignore does NOT exclude. Note faucet.env is
# in here: replacing .dockerignore with *.md plus !README.md means the env file is no
# longer excluded and so IS expected, which is the fixture's own premise and the thing my
# first attempt at this test got wrong.
rm -rf "$T/img"; mkdir -p "$T/img/app/src" "$T/img/app/deploy/z3"
cp "$R/src/a.ts" "$R/src/b.ts" "$T/img/app/src/"
cp "$R/deploy/z3/faucet.env" "$T/img/app/deploy/z3/"
cp "$R/.dockerignore" "$R/README.md" "$T/img/app/"
( cd "$T/img" && tar -cf "$T/img.tar" app )
check "a negated file is EXPECTED and matches, so it is verified rather than skipped" \
  "[ \"\$(vim_run)\" = '0' ]"

echo "== verify-image-manifest: and a negated file MISSING from the image is caught"
# The half that proves the negation is load-bearing. Before this, README.md was silently
# excluded from the comparison, so an image missing it passed.
rm -f "$T/img/app/README.md"; ( cd "$T/img" && tar -cf "$T/img.tar" app )
check "a negated file absent from the image exits 1" "[ \"\$(vim_run)\" = '1' ]"
check "and names it" "grep -q 'README.md' '$T/out'"

echo "== verify-image-manifest: an excluded file with no negation stays excluded"
# The control. If everything were expected, the two checks above would pass for the wrong
# reason: NOTES.md must NOT be demanded of the image.
check "NOTES.md is never demanded" "! grep -q 'NOTES.md' '$T/out'"
