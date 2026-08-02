#!/usr/bin/env bash
# BUILD THE CROSSLINK NODE FOR THE BOX, IN A CONTAINER, AND PROVE WHAT CAME OUT.
#
# #327's first line: never compile this on the box. It is a Rust monorepo carrying zebra,
# librustzcash, zaino and zingolib, it took 6m07s on a fast laptop with a warm registry,
# and a box running a live faucet should not own a toolchain.
#
# NOTE ON THE PATTERN. #327 said "same pattern as the miner: built in a container, binary
# shipped". That pattern did not exist: the miner is compiled ON the box by
# bring-to-spec.sh. This script establishes it. Moving the miner onto it is the follow-up,
# and it closes a gap I put there myself.
#
# THE CHECK THAT MATTERS IS THE ARCHITECTURE ONE. On an arm64 laptop a misconfigured
# buildx happily produces an arm64 binary, and every step reports success. Nothing notices
# until the box says "cannot execute binary file", by which point it is a deploy failure
# rather than a build failure. So the output is inspected and the run REFUSES unless the
# binary is actually for the platform that was asked for.
#
# EXIT CODES, as everywhere else in this stack:
#   0  a binary for the requested platform exists, with its sha256 printed
#   1  KNOWN-BAD, the build ran and produced the wrong thing
#   2  CANNOT-VERIFY, something needed to answer was missing
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM="${CTAZ_PLATFORM:-linux/amd64}"
SOURCE_REPO="${CTAZ_SOURCE_REPO:-https://github.com/ShieldedLabs/crosslink_monolith}"
# Pinned in the repo so the revision that ships goes through review like anything else.
SOURCE_REV="${CTAZ_SOURCE_REV:-2c346b29c06ec19cd5ad4e58752d531888342157}"
OUT_DIR="${CTAZ_OUT_DIR:-$HERE/ctaz-build/out}"
IMAGE_TAG="${CTAZ_IMAGE_TAG:-ctaz-zebrad-build:local}"
DOCKER="${CTAZ_DOCKER:-docker}"

log() { echo "$(date -u +%FT%TZ) ctaz-build: $*"; }
die_unverifiable() { log "CANNOT VERIFY: $*"; exit 2; }

command -v "$DOCKER" >/dev/null 2>&1 || die_unverifiable "no docker on this host"
[ -f "$HERE/ctaz-build/Dockerfile" ] || die_unverifiable "no Dockerfile at $HERE/ctaz-build/"

case "$PLATFORM" in
  linux/amd64) want_arch="x86-64" ;;
  linux/arm64) want_arch="aarch64" ;;
  *) die_unverifiable "unsupported platform '$PLATFORM'; this script only knows how to VERIFY amd64 and arm64, and building without verifying is the thing it exists to prevent" ;;
esac

mkdir -p "$OUT_DIR" || die_unverifiable "cannot create $OUT_DIR"

log "platform  $PLATFORM"
log "source    $SOURCE_REPO @ $SOURCE_REV"
log "note      an emulated cross build takes considerably longer than a native one"

if ! "$DOCKER" build \
      --platform "$PLATFORM" \
      --build-arg "SOURCE_REPO=$SOURCE_REPO" \
      --build-arg "SOURCE_REV=$SOURCE_REV" \
      --target artifact \
      -t "$IMAGE_TAG" \
      "$HERE/ctaz-build"; then
  log "ERROR: the build failed. Nothing was extracted."
  exit 1
fi

# `docker create` against a scratch image gives a container to copy from without running
# anything, which is what we want: an amd64 binary is not executable on an arm64 host, so
# the artifact must never need to run in order to be extracted.
cid="$("$DOCKER" create --platform "$PLATFORM" "$IMAGE_TAG" 2>/dev/null)"
[ -n "$cid" ] || die_unverifiable "could not create a container to extract from"
# shellcheck disable=SC2064
trap "$DOCKER rm -f '$cid' >/dev/null 2>&1" EXIT

if ! "$DOCKER" cp "$cid:/zebrad" "$OUT_DIR/zebrad" >/dev/null 2>&1; then
  log "ERROR: the image exists but /zebrad could not be copied out of it"
  exit 1
fi
[ -s "$OUT_DIR/zebrad" ] || { log "ERROR: extracted an EMPTY zebrad"; exit 1; }

# ── the assertion this script exists for ─────────────────────────────────────────
if ! command -v file >/dev/null 2>&1; then
  log "CANNOT VERIFY: no \`file\` on this host, so the binary's architecture was not"
  log "  checked. It may well be correct. Shipping it on that basis is how a wrong-arch"
  log "  binary reaches a box and fails at exec time."
  exit 2
fi
desc="$(file -b "$OUT_DIR/zebrad" 2>/dev/null)"
log "extracted $OUT_DIR/zebrad"
log "  $desc"
case "$desc" in
  *"$want_arch"*) : ;;
  *)
    log "REFUSING: asked for $PLATFORM, which needs '$want_arch', and got something else."
    log "  That is the failure this check exists for. An arm64 binary shipped to an amd64"
    log "  box fails at exec, long after the build reported success."
    exit 1 ;;
esac
case "$desc" in
  *ELF*) : ;;
  *) log "REFUSING: not an ELF binary, so it cannot run on the box"; exit 1 ;;
esac

# The compiler is not pinned (their rust-toolchain.toml says `stable`), so record what
# actually built this. Cannot reproduce it, can at least identify it.
rustc_used="unknown"
if "$DOCKER" cp "$cid:/rustc-version.txt" "$OUT_DIR/rustc-version.txt" >/dev/null 2>&1; then
  rustc_used="$(tr -d '\r\n' < "$OUT_DIR/rustc-version.txt")"
fi

sum="$(sha256sum "$OUT_DIR/zebrad" 2>/dev/null | awk '{print $1}')"
[ -n "$sum" ] || sum="$(shasum -a 256 "$OUT_DIR/zebrad" 2>/dev/null | awk '{print $1}')"
size="$(wc -c < "$OUT_DIR/zebrad" | tr -d ' ')"
log "verified: $want_arch ELF, ${size} bytes"
log "sha256:   ${sum:-unknown}"
log "rev:      $SOURCE_REV"
log "rustc:    $rustc_used   (NOT pinned: their rust-toolchain.toml says stable)"
log "Ship this file. Do not build on the box."
exit 0
