# Contributing

This is how the faucet team actually works. It is short because every rule in
here is enforced, not aspirational.

## Branch and worktree flow

All of us share one clone, so nobody works in the main checkout. One branch,
one worktree, one directory:

```sh
cd zcash-faucet
git fetch
git worktree add -b feat/your-thing ../zcash-faucet-your-thing main
cd ../zcash-faucet-your-thing
```

Do all your work there. When the branch merges, clean up with
`git worktree remove ../zcash-faucet-your-thing`.

Two hard rules:

- Never commit to main. Never push. The CTO merges after review, always.
- Shared files need a heads-up before you touch them. `package.json` and the
  test script belong to everyone, so clear changes with the CTO first.

## The review gate

Every branch goes through the same pipeline, and nothing skips a step:

1. Mark your branch ready and send it to QA first, not the CTO: branch name,
   a two-line summary, and what you checked.
2. QA runs a first pass: typecheck, tests, build, then actually exercising
   the change (a browser for frontend, stubs for infra scripts). Findings go
   back to you, the engineer.
3. You fix your own findings, QA re-checks, and you iterate until clean.
4. QA forwards the approved branch to the CTO.
5. The CTO does the final audit and merges. Anything the audit finds comes
   back to you the same way QA findings did. You wrote it, you fix it,
   nobody else touches your branch.

The separation is the point: engineers write and fix, QA finds, the CTO
audits and merges. Nobody reviews their own work and nobody fixes someone
else's. QA's own branches skip step 2 in the obvious way and go straight to
the CTO.

"It works on my machine" is not a first pass. If it renders, drive it. If it
executes, run it.

## Build and test, the local loop

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm test            # node --test, needs Node 23+ (native type stripping)
npm run build       # next build
```

Gotchas that have already bitten us once each:

- The unit tests are TypeScript run straight through `node --test`. That
  relies on native type stripping, so Node 23 or newer is required. CI pins
  23.x for this reason. Do not "fix" the test script to work around an old
  local Node without talking to the CTO.
- `npm run dev` does not bundle (a `node:` import in `src/lib/zcash/t2z.ts`).
  Verify changes against `npm run build` and `npm start`, never dev.
- Shell scripts in `deploy/` must pass `shellcheck` at warning severity.
- The shell test harness has one entrypoint, `deploy/z3/tests/run-tests.sh`.
  Never glob the tests directory: `stubs/` holds fake binaries the runner
  puts on PATH, not test files.

CI runs all of this on every PR and on pushes to main. Green on CI is the
floor, not the bar. The bar is that you exercised your change for real.

## House voice

Everything a human reads is written like a senior engineer talking to peers:
commits, PR descriptions, code comments, UI copy, review notes.

- No em dashes. Use a comma, a colon, or a new sentence.
- No semicolons in prose. Code is fine, sentences are not.
- Say the thing the diff cannot: the why, the tradeoff, what you ruled out.
  Do not narrate the changes file by file.
- No AI slop. If a sentence would fit in a press release ("comprehensive",
  "robust", "seamless", "leverage"), cut it and say the concrete thing.
- Match length to the change. A one-line fix gets a two-line PR.

Commit subjects follow the log: lowercase, plain, specific. Read
`git log --oneline -20` before inventing a style.
