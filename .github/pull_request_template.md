<!-- Two lines on the problem before anything else. The diff shows the what,
     this box is for the why. -->

## What and why


## Key decisions

<!-- Only the non-obvious ones: tradeoffs, alternatives you ruled out.
     Delete this section if there are none. -->

## Testing

<!-- What you actually ran, with real output. "Tested locally" is not
     evidence. Screenshots for UI, command output for scripts. -->

- [ ] `npm run typecheck`
- [ ] `npm test` (Node 23+)
- [ ] `npm run build` (never dev, it does not bundle)
- [ ] `shellcheck -S warning` on any touched `deploy/` scripts
- [ ] Exercised the change for real (browser for UI, stubs for infra)

## Risks and follow-ups

<!-- What the reviewer should watch, plus anything deliberately out of
     scope. Delete if empty. -->

---

Before requesting review: no em dashes, no semicolons in prose, no commits to
main, and the branch came from its own worktree. Send a ready branch to the
OTHER engineer, never to the CTO and never to yourself. You fix your own
findings, the reviewer re-checks and hands it to the CTO, the CTO merges.
