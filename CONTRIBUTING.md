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

### Rebasing while a merge drive is running

Always `git fetch` and rebase onto `origin/main`, never onto a branch that is
about to merge or has just merged. A squash merge gives main the same CONTENT
under a new SHA, so a branch built on the pre-squash tip is right in content and
wrong in ancestry, which is the state git calls DIRTY. One night produced eight
rebases and seven were this, wearing three different costumes:

- a branch carrying commits already squashed into main, whose PR then showed 23
  files for a one-line change
- a branch whose parent was rewritten under it, producing a conflict whose
  incoming side was EMPTY, which is the shape that tempts you to resolve by
  deleting something real
- a branch that went dirty again each time the car ahead of it landed

The fix for all three is the same. Replay only your own commits:

```sh
git fetch origin
git rebase --onto origin/main <the-last-commit-you-do-not-own>
```

Read every conflict hunk rather than trusting a pattern. A dry run correctly
predicted the same one-hunk conflict in the same file for three cars in a row,
and the correct resolution was different each time: a union, then a rename where
a union would have left a live token and a dead one with no error anywhere.

## The review gate

Every branch goes through the same pipeline, and nothing skips a step:

1. Mark your branch ready and send it to the OTHER engineer. Not the CTO, and
   there is no QA seat: branch name, a two-line summary, and what you checked.
2. **Check the author before you route anything.** Sending a branch to its own
   author silently removes the gate and leaves a review comment sitting under it
   that looks exactly like the gate held.

   **Do not use `git` or `gh` for this. They cannot answer it.** Everyone here
   pushes through one GitHub account, so every field that looks like authorship
   is the same for all of us. Measured across two seats' branches:

   ```
   gh pr view 221 --json author  ->  author.login=Giri-Aayush   (App's)
   gh pr view 218 --json author  ->  author.login=Giri-Aayush   (Infra's)

   git log --format='%an <%ae> / %cn <%ce>' on either branch
     ->  Aayush Giri <aayushgiri1234@gmail.com> / same, byte for byte
   ```

   Author, committer, email and `gh`'s login are identical, and there are no
   trailers. So a routing decision read from them is a coin flip wearing the
   costume of evidence, which is worse than having no check: it produces a
   confident wrong answer. This nearly sent three of one seat's own PRs back to
   that seat for review, and only a human memory of who wrote what caught it.

   **What does work**, in order of reliability: which seat holds the local
   branch or worktree, and what each seat said over IPC when it opened the PR.
   Both are outside git, which is the whole point.

   **If you cannot establish it, ask.** "Who authored this" is one message and
   an unanswered gate is worth more than a fast one.
3. The non-author reviews: typecheck, tests, build, and then actually
   exercising the change (a browser for frontend, a running server for routes,
   stubs for infra scripts). Findings go back to the author.
4. The author fixes their own findings. The reviewer re-checks, and you iterate
   until clean.
5. The reviewer hands it to the CTO.
6. The CTO audits, confirms a green run on the exact head that will merge, and
   merges. Anything the audit finds comes back to the author the same way the
   reviewer's findings did. You wrote it, you fix it, nobody else touches your
   branch.
7. The CTO then watches the post-merge run on `main` to green. This is not
   optional and it is not paperwork: a PR that was green on its own head has
   reddened `main` after merging, and the gap between "merged" and "someone
   noticed" is where that sits unseen.

The separation is the point: the author writes and fixes, the non-author finds,
the CTO audits and merges. Nobody reviews their own work and nobody fixes
someone else's.

Two things about step 6 that have each cost a day. Confirm the green run on the
head that will actually merge, because a run against a commit two behind is a
true statement about the wrong object (rule 25). And six of seven jobs is not
seven: a job still in progress is not a pass.

"It works on my machine" is not a first pass. If it renders, drive it. If it
executes, run it.

### Where a verdict is written down

Findings and verdicts go in a **PR comment**, not a GitHub review. The team
pushes under one GitHub account, so from GitHub's side every PR on this repo is
self-authored, and `gh pr review --approve` fails outright with "Can not approve
your own pull request". CHANGES_REQUESTED is refused for the same reason.

The consequence that matters when you are reading the board: **on this repo
`MERGEABLE BLOCKED` never means a PR is waiting on a person. It means CI.** That
inference is wrong here and the UI gives you no hint, which cost a full day of a
wrong mental model before anybody tried to file an approval and got told why.

So the gate is the IPC verdict plus the CTO's audit, and it always was. Write
the verdict into a PR comment anyway: IPC scrolls away with the session, and
the next person reading `git log` deserves to find out why something merged.

The same single account is why **step 2 above tells you not to check authorship
with `git` or `gh`**. That fact lived in this paragraph while step 2 said to take
one `gh` read, twenty lines apart, and nobody connected them until a routing
decision nearly sent three PRs back to their own author. If you change one of
these two places, change the other.

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
- A job spec only exists in the shell that created it. `npm start &` in one
  shell and `kill %1` in another kills nothing and reports nothing, which is
  how 51 orphaned `next-server` processes ended up holding ports on one
  machine. Tear down by port instead, and read the port back, because a kill
  is a claim like any other:
  `pid=$(lsof -ti :PORT -sTCP:LISTEN | head -1); kill "$pid"`. Never
  `pkill -f next-server` on a shared box, since a teammate is probably
  mid-assertion on one of them.

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
   confirm the cause before acting on it. This includes tooling, and the
   instance to know by name: any `gh` command that walks the classic-Projects
   GraphQL path fails on `repository.issue.projectCards`. `gh pr edit` has
   silently left a title and body unchanged, and `gh issue view` refuses
   outright. Route around it with `gh api` (`-X PATCH` to write, `--jq` to
   read) and read the state back after any mutating command.
8. Uncertainty is cheap, confident wrongness is expensive. "I could not
   verify X" is always an acceptable report. "X is done" when it is not is
   the one unforgivable one.
9. Read first, compose second, in that order. Rule 1 is not enough on its
   own: a status report written before its `gh` read and sent after it
   carried a VERIFIED label on an issue that had already merged. Every fact
   in a report has to be younger than the sentence that states it.
10. "Main passes, my branch fails, therefore the environment" is not a
    diagnosis. It is the shape of a conclusion you want to be true. A red
    audit job on a green `main` was a dependency pin this branch had deleted,
    and the difference between the two branches was the evidence, not the
    alibi.
11. No bulk operations on a shared surface. Name the paths on `git add`, and
    merge into a structured key instead of assigning it. Both halves of that
    rule come from a real loss: a script wrote the whole `overrides` key and
    deleted the security pins inside it, and `git add -A` swept an unrelated
    file into a PR already under review. `git checkout <ref> -- .` belongs on
    the same list. The safe version of each costs one extra word.
12. Correct it before the reviewer finds it. A `--force-with-lease` and a
    message naming the old and new SHA costs a minute. Being caught later
    costs the reviewer's trust in everything else in the branch.
13. When your measurement disagrees with the author's claim, suspect your
    instrument first. Three near-miss findings in one night were all the
    harness: a contrast probe read its reference colour from `body`, which is
    transparent because the theme paints a wrapper, and reported 2.03:1 where
    the author said 7.96; an `lsof -ti :PORT` kill took down the client
    connection alongside the listener, so an outage test looked like a crash;
    a stale `.next` from another branch's build failed a typecheck. Reproduce
    the author's number their way before writing the word FAIL.
14. A test that can only pass ONCE is not a passing test. Rule 4 covers an
    assertion that cannot fail. This is its twin, an assertion that cannot
    fail twice. The integration suite's hang test claimed a fixed address, and
    the unknown-outcome path it exercises holds the full cooldown on purpose,
    so the first green run poisoned its own fixture and every run after it got
    a cooldown 429. The failure read as broken deadline logic, so it pointed at
    innocent code. The ledger is `$cwd/data/faucet.db` with no override, shared
    by every app instance a test boots and surviving between runs, so anything
    that writes a claim needs a fresh address per run. Run a suite twice before
    you believe it once.

15. Assert against the shipped code path, never a copy of its logic. Rule 4
    cannot catch this class: sabotaging the code changes nothing when the test
    never runs it. My snapshot suite reported 351/351 while every
    pointer-driven restore silently rebuilt from a day-old archive. The test
    reimplemented the parse loop, and the copy happened to omit the single
    guard line that caused the failure, so it certified a paraphrase. The
    fixture was right, the format matched production exactly, and none of that
    mattered because the shipped parser never ran. If asserting against the
    real path needs a server, a socket or a subprocess, stand one up: the
    pointer path is now a real HTTP server and real archives with the script
    invoked, and every assertion reads the script's own output. When a test
    contains a second implementation of the thing it checks, it has stopped
    being a test.
16. Know which of your numbers the system cannot check about itself. Most
    constants are derivable or assertable, and a test pins them honestly. A few
    are claims about the world outside the process, and for those a test can
    only prove the arithmetic around them is consistent, never that the input is
    true. Three shipped examples. The 100k H/s browser hashrate that sets the
    PoW ceiling is a claim about a phone we do not own. The 279s zallet worst
    case behind the send deadline was derived by reading the sender's control
    flow and never measured against a real wallet under load. And
    `ZSNAP_EXPECT_HASH` was a claim about an archive nobody re-checked. Each is
    a single value that decides whether a safety mechanism is real. Write down
    what it was measured against and when, next to the value rather than in a
    commit message, and choose units so the pessimistic direction is the cheap
    one. Being wrong toward caution costs latency. Being wrong toward optimism
    cost a live user their claim in #132.
17. Before believing a null result, prove the question can return non-null.
    An empty answer from a broken question looks exactly like an empty answer
    from a good one, and the second is a finding while the first is nothing.
    Four in one morning. A `grep` for a symbol in the zallet image returned
    nothing, and the image is distroless with no `sh`, so the probe had never
    executed at all: a positive control on a symbol that must exist is what
    showed it. A systemd unit reported inactive was the wrong unit name, and
    the real one had been running for a day. A 64-hex string pulled from an
    explorer 404'd on a `/tx/` route because it was a block hash, not a txid,
    which was one step from being reported as the explorer rejecting real
    chain data. And `bash /opt/faucet/audit-drift.sh` reported `exit: 0` for a
    file that does not exist, because `$?` was read after a pipe through `tail`
    and gave `tail`'s status rather than the script's 127. In all four the tool
    was silent, not the world. Pair every negative check with a positive one
    whose answer you already know, and when a status arrives through a pipeline,
    make sure it is the status of the thing you meant to ask.
18. A test double defines which failures are expressible. A gap in the double
    is a gap in what can ever be tested, so a component can lie for months
    with a green suite and nobody has been careless. The docker stub listed
    only `running` containers while the watchdog calls `docker ps -a`
    precisely to see a stopped one, so crash-loop behaviour was
    unrepresentable and 812 false recoveries went unnoticed (#175). The
    miner's loopback server did one `read()` into an 8 KB buffer, and
    `submitblock` is the one call whose body is tens of KB, so the only
    large-body path had no reachable test (#166). A blackhole harness built
    to test an outage made the working-oracle case unreachable, which is how
    a CI failure was missed while its output was on screen (#171). When a
    behaviour resists testing, suspect the double before the code.
19. A code path proves what CAN happen, never what IS happening. Reading real
    code and reasoning correctly still produces a claim about the world, and
    the world gets a vote. Two in one morning. A placeholder-salt chain through
    `deploy.sh`, `saltGuard` and `config.ts` was real code and not the live
    fault. A flag defaulting false with no `deploy/` entry was real code, and
    the flag was set true in production all along. Both were settled in seconds
    by a single read from the box. Finish with a read from the thing itself, and
    when you cannot get one, say the claim is unverified rather than shipping the
    inference. This applies hardest to your own diagnosis, because a clean
    mechanism is exactly what makes a wrong one persuasive.
20. An assertion over two derived collections must prove the collection is
    real first. Otherwise the empty case passes for free, and it passes
    hardest when the tool that builds the collection is missing. `drift`'s
    read-only check compared two `sha256sum` listings, and on a host without
    `sha256sum` both were empty, compared equal, and reported `ok` while a
    file was rewritten between them (#167). Equality is only evidence when
    inequality is reachable, so pin both: that the listing found something,
    and that a real change is detected.

21. Absent information needs its own state, and the caller must refuse on it.
    A missing count is not a zero. A missing tip is not a safe tip. Two states
    force the unknown case to collapse into one of them, and it collapses toward
    whichever is permissive, because that is the branch nobody notices. So give
    it a third: `cannot-verify` beside not-frozen and frozen (#171),
    `cannot-tell` beside recovered and still-broken (#175),
    `count-not-reported` beside nothing-visible and present-but-unspendable
    (#174), `unverifiable` beside safe and unsafe on the shield gate. Four in one
    week, each found after a boolean had already shipped.
    The sharpest case is two checks needing OPPOSITE failure modes on the same
    input. Readiness must fail OPEN on a null external tip, because a public
    endpoint going down must not take a healthy faucet with it. The gate that
    authorises moving money must fail CLOSED on the identical value, because
    cannot-verify is not clearance. Those live a few lines apart in the same file
    and read as an inconsistency worth tidying, which is exactly how the wrong
    one gets copied. Write which direction each failure takes and why, next to
    the code, because the tidy version of this is the dangerous one.

22. Fail-closed, applied without thinking, invents a new way to fail. The
    freshness gate refuses to pay out when it cannot verify the chain tip, which
    is right. `getExternalTip()` is deliberately NON-BLOCKING, so the first read
    after its cache ages out returns null and only then starts a refresh, which
    is also right. Composed, they meant a healthy faucet with a funded wallet
    refused a real user's claim after five quiet minutes, and told them our node
    was behind when the truth was that we had not asked lately (#187). So on a
    path that moves money, ASK before deciding, bounded, and let the timeout be
    the thing that produces cannot-verify. "We could not establish it" has to
    mean the network would not tell us, never that we did not get round to
    checking. Refusing for a reason that is not true is its own outage.

23. Awaiting a coalesced refresher can be a silent no-op. `warmExternalTip()`
    returns immediately when a refresh is already in flight, and the read that
    just returned null is precisely what started that refresh, so awaiting it
    resolves at once and you read the same null. Nothing errors. Poll for the
    VALUE with a deadline, never await the thing that fetches it, whenever the
    fetcher deduplicates. The reason this is a rule and not a bug report: the
    warning was already written down, by me, in the test file for the previous
    change, and I walked into it anyway a few hours later. Documenting a trap
    is not the same as heeding it, so the safe shape has to be the one in the
    code rather than the one in a comment above it.

24. A module that will not load is a module with no tests, and nothing tells
    you. `refiller.ts` built its implementation through `require()`, which is
    undefined in an ES module, and the reserve modules used extensionless
    imports that Next resolves and `node --test` does not. Between them the
    whole refill path was unloadable under the test runner, so the reconciler
    had never had a single test, and no count, no suite name and no green run
    ever mentioned it. Rules 15 and 18 are about what a test can express. This
    is the floor under them: check that the module you believe is covered can
    be imported by the runner at all, because zero tests looks exactly like
    passing tests from the summary line. That gap is a real part of how #172
    got as far as it did.

25. When two figures for the same thing disagree, one of them is wrong, and
    "both sound bad enough" is not a resolution. The temptation is to accept
    whichever number supports the action you were going to take, because both
    point the same direction. Find out what each figure is actually OF. A CI run
    read six of seven jobs green while another reading of the same branch read
    seven of seven, and neither was a mistake: one described the branch tip, the
    other a commit two behind it. The reviewer who reconciles them says "the run,
    not the branch" and moves on. The one who does not either blocks a green PR
    or clears a red one, with a straight face either way.

26. A detector has to prove it can still FIRE, not just that it passes. A check
    that looks for a key by name matched the key in a COMMENT, so the comment
    written to explain why the key mattered was enough to silence the check for
    that key: documenting the problem hid it (#188). It was caught by deleting
    the real assignment and watching the audit stay quiet, which is rule 4's
    sabotage applied to a detector rather than a test. Match the thing that
    carries the meaning, an assignment and not a mention, then break it and
    watch the alarm go off.

27. For every threshold, ask what happens when it is NOT a number. This is where
    a guard silently disappears rather than misbehaving. `Number("trlue")` is
    `NaN`, `lag > NaN` is false for every lag, so one typo in an env file turned
    the shield gate into a pass-through that reported a 220,000-block lag as
    safe, with its own reason string reading "within NaN blocks" (#171). The same
    typo would have switched off the frozen-node detector that exists because of
    Fauzec's faucet, and the stall detector, which then reported `stalled: false`
    beside `stalledMs: 86400000`. Three guards, one keystroke each. Parse through
    a helper that THROWS (`num()` in `config.ts`) rather than one that coerces:
    failing to boot on a value we cannot parse is the same discipline as refusing
    to broadcast on a tip we cannot verify. And clamp the parsed value, because a
    budget an operator can set past the cliff is a comment, not a limit.

28. `merged` is not `shipped`. GitHub reporting a pull request MERGED means a
    merge succeeded, never that the code reached the branch that deploys. #220 was
    stacked on #219's branch so a reviewer could see a migration and its first
    consumer together. #219 was squash-merged to main, which does NOT re-target a
    stacked child, and its branch was not deleted, so 99 seconds later #220 merged
    cleanly into a branch that no longer led anywhere. 405 lines of reviewed
    anti-farming code, `merged=true` and closed, absent from main for an hour while
    the board said the Sybil lever had shipped. Nothing failed: no conflict, no red
    CI, no warning. Both of us verified it and both asked the wrong question, the
    author by trusting the merge and the CTO by reading `state,mergeCommit` and
    getting MERGED plus a sha.

    So the check is two facts, not one, and neither is the merge result:

    ```
    base == main                                        before merging
    git merge-base --is-ancestor <merge_sha> origin/main  after merging
    ```

    It was found by accident, which is the part worth remembering. A schema
    comment reading "Nothing reads it yet", written as a note about sequencing,
    had quietly become literally true. If you stack, delete the parent branch when
    it merges or re-target the child first, and audit with the ancestor check
    rather than by reading anything.

29. A negative control proves an instrument can say NO. It says nothing about
    whether that instrument can say YES. Rule 26 is about our own detector firing;
    this one is about a measuring device we merely READ, where the danger is that
    "not there" and "I cannot see it" come back as the same value.

    Concretely: to decide whether a coinbase was paid into a shielded pool, I chose
    an explorer's per-transaction pool fields over writing a decoder, on the stated
    grounds that an unvalidated parser would be a new source of error placed right
    in front of the question. I then validated that choice against a known
    TRANSPARENT coinbase. Every shielded field read zero, exactly as it should, and
    I wrote down that a later non-zero reading would therefore mean something.

    It would not. Our own recovery sweep, which moved ~50 TAZ into the shielded
    pool, reads from the same endpoint as `hasShieldedData: false`, every pool
    balance zero, `totalOutput: 0`, and `fee: 50.00125`: it cannot decode the pool,
    so it books the entire shielded output as a fee. A transparent transaction and a
    shielded one it cannot read are byte-identical through that instrument. My
    control could not have caught it, because I validated only the arm that says no.

    So: every oracle needs a known-POSITIVE control as well as a known-negative one,
    and they have to return *distinguishable* answers before either is trusted. The
    two-arm form of the same rule, which cost a wrong conclusion in the other
    direction the same night: **if the control and the test agree, the comparison has
    no discriminating power and cannot support either conclusion, including the
    reassuring one.** A reproduction where both arms returned the same answer nearly
    had one of us tell the other their funds-adjacent bug report was mistaken.

    Worth keeping the provenance: this was not caught by diligence. It was caught by
    reaching for the same explorer for an unrelated privacy claim and noticing a
    50 TAZ fee. The rule is here so the next person does not need that accident.

30. Say when a detector reaches nobody. `#215`, the alert webhook, is DEFERRED:
    the logic exists, and with no URL configured it posts into the void. So
    `#175`'s escalation, `#214`, `#224` and `#240` are all correct and all
    currently land in silence. That is a known and accepted state, not a defect to
    re-raise every cycle.

    The hazard is the reader six weeks out. Someone greps "the watchdog escalates",
    finds it, and believes a human gets woken. Nothing in the code contradicts
    them, because the code does escalate: it escalates to a sender with nowhere to
    send. Exactly the shape of the schema comment reading "Nothing reads it yet"
    that quietly became literally true while a merged feature sat on a dead branch
    (rule 28).

    So any NEW alerting or monitoring work states plainly, in its issue or PR, that
    it currently reaches nobody, and links `#215`. One sentence. And when writing
    about alerting that already exists, keep the tense honest: "posts to a webhook
    when one is configured" is true, "wakes someone up" is a claim about today and
    today it is false.


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
