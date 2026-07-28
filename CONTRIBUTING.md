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

## Verification

One night produced several false positives: locally accepted blocks reported
as funding, a merge reported from memory, an error string trusted over the
source, and a money-path PR that skipped review and carried a funds bug.
Every correction came from the same few habits, so the habits are rules.

1. Never report a state you have not verified with a fresh command in this
   session. Board states come from `gh`, balances come from the node, never
   from memory or from your own earlier message.
2. Label every claim in a report: VERIFIED (the command and what it said),
   INFERRED (from what), or ASSUMED (say so). A reader must be able to tell
   which is which without asking.
3. Compiles and tests-pass are not works. Acceptance means the behavior was
   exercised: in a browser for UI, against a running server for routes,
   adversarially for anything touching money.
4. Break your own test before trusting it. An assertion that cannot fail
   when the code is sabotaged is not a test. Canonical trap: on a
   server-rendered React page, `html.includes(x)` passes on the serialized
   props alone, so assert on visible text and prove it fails on a broken
   render.
5. Local acceptance is not network truth. Our node accepted eight mined
   blocks and the chain orphaned all eight. The same gap exists for anything
   with an external party on the other side.
6. Read the source, do not recall it. Every correct call that night came
   from reading the code, every wrong one came from remembering it or
   trusting a summary of it.
7. Error messages are claims, not facts. Treat the message as a lead and
   confirm the cause before acting on it. This includes tooling: `gh pr
   edit` has failed here while printing only a deprecation warning, so
   read the state back after any mutating command.
8. Uncertainty is cheap, confident wrongness is expensive. "I could not
   verify X" is always an acceptable report. "X is done" when it is not is
   the one unforgivable one.

Money paths (send, ledger, reservation, PoW verify) never skip review, no
matter how urgent the window. Docs and pure test additions may fast-track
at the CTO's discretion.

## Comments

One or two lines, and they say why, never what the next line does. Anything
longer moves to a doc and the comment points at it. The repo is public and
every file is a writing sample. Existing long comments get trimmed when you
touch the file, no dedicated sweep.

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
