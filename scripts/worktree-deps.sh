#!/usr/bin/env bash
# Give a git worktree its node_modules without paying for a second copy (#243).
#
# Worktrees are cheap on git objects and expensive on node_modules: each one costs
# about 450 MB, and the cost is invisible when you create one because it only shows
# up later as a full disk. A near-full volume wedged the Docker daemon today and
# blocked the scratch-node runs for #201 and #195.
#
# WHAT IT ACTUALLY RECLAIMS, because the issue overstated it by 11x and somebody
# will read this comment before the issue. Measured 2026-07-30: 78 node_modules
# directories under $HOME totalling 9.88 GB, of which OUR worktrees were 0.89 GB,
# 9% of it. The rest is npm's own npx cache at 2.2 GB and three parallel .aztec
# toolchain versions at 2.9 GB, neither of which this touches. So this is worth
# having because the cost recurs on every worktree, not because it frees 11 GB.
#
# The link is only safe when the dependency trees would be identical, so it compares
# lockfile hashes and installs when they differ rather than assuming they match. A
# symlink to the wrong tree is worse than a second copy: it fails at build time with
# an error that points at your code.
set -euo pipefail

main_checkout="${WORKTREE_DEPS_SOURCE:-}"
if [ -z "$main_checkout" ]; then
  # The worktree list's first entry is the main checkout, which is the one that owns
  # a real node_modules by convention.
  main_checkout="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
fi
here="$(git rev-parse --show-toplevel)"

die() { printf 'worktree-deps: %s\n' "$*" >&2; exit 1; }
note() { printf 'worktree-deps: %s\n' "$*"; }

[ -n "$main_checkout" ] || die "could not find the main checkout, set WORKTREE_DEPS_SOURCE"
[ "$main_checkout" != "$here" ] || die "run this from a worktree, not from the main checkout ($here)"
[ -f "$here/package-lock.json" ] || die "no package-lock.json in $here"
[ -f "$main_checkout/package-lock.json" ] || die "no package-lock.json in $main_checkout"

hash_of() { shasum "$1/package-lock.json" | cut -d' ' -f1; }
mine="$(hash_of "$here")"
theirs="$(hash_of "$main_checkout")"

if [ "$mine" != "$theirs" ]; then
  # Not an error. Divergent lockfiles are the normal state of a branch that changes
  # dependencies, and the honest answer is a real install rather than a link that
  # would resolve to the wrong tree.
  note "lockfiles differ (${mine:0:12} vs ${theirs:0:12}), so this worktree needs its own install"
  note "running npm ci"
  npm ci
  exit 0
fi

if [ ! -d "$main_checkout/node_modules" ]; then
  die "lockfiles match but $main_checkout has no node_modules to link, install there first"
fi

if [ -L "$here/node_modules" ]; then
  current="$(readlink "$here/node_modules")"
  [ "$current" = "$main_checkout/node_modules" ] && { note "already linked to $current"; exit 0; }
  note "relinking from $current"
  rm "$here/node_modules"
elif [ -d "$here/node_modules" ]; then
  # A real directory here is the duplicate copy this script exists to remove, so say
  # what is being deleted and how much it was costing rather than doing it silently.
  size="$(du -sh "$here/node_modules" | cut -f1)"
  note "replacing a real $size node_modules with a link to the main checkout"
  rm -rf "$here/node_modules"
fi

ln -s "$main_checkout/node_modules" "$here/node_modules"
note "linked node_modules -> $main_checkout/node_modules (lockfiles match at ${mine:0:12})"

# Prove it resolves rather than trusting that a symlink is enough: a link into a
# directory that has been emptied looks fine to `ls` and fails at build time.
node -e 'require.resolve("next")' >/dev/null 2>&1 \
  && note "verified: node can resolve a dependency through the link" \
  || die "the link is in place but node cannot resolve through it, so the source tree is incomplete"
