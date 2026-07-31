# Miner heartbeat: the file contract

Agreed between Infra (writes it) and App (reads it). Two changes came out of that review and
both are recorded below with the reason, because the reasons are the useful part.

## Why this exists

`/api/status` reported the miner's state from `process.env.FAUCET_MINER_ACTIVE === "true"`.
That is an env flag: it says what an operator configured, not what is happening, and it
**cannot be false while the miner is broken** — the definition of a check that proves nothing.

It read "miner on" for 70 minutes while the miner errored every 5 seconds on `getblocktemplate`
with an auth cookie zebra had regenerated on restart. The process was alive, the unit was
`active`, nothing noticed. It was found by looking at the box for an unrelated reason.

Mining stays always on. This is not a gate on it; it is about knowing whether it is running.

## The one idea that makes it catch that failure

**Two timestamps, and their divergence is the signal.**

- `writtenAt` is rewritten on **every** beat, including beats where the loop errored.
- `lastTemplateAt` advances **only** when a template was actually fetched.

Process-alive-but-templates-stopped shows up as a *fresh* `writtenAt` beside a *stale*
`lastTemplateAt`. A heartbeat that only proved the process was running would rebuild the same
false pass one layer down, which is precisely what this must not do.

## Location and ownership

    host:      /var/lib/faucet-miner/heartbeat.json     (systemd StateDirectory)
    container: /var/lib/faucet-miner/heartbeat.json     (bind-mounted READ-ONLY)

The path comes from `MINER_HEARTBEAT_PATH` and **has no default that points anywhere real**, so a
missing configuration cannot write to a stale path and cannot be mistaken for a working
heartbeat. Unset means the miner does not write one and says so once at startup; the reader then
sees an absent file, which is `cannot-verify`. Those compose correctly.

The mount is `:ro` on purpose: the miner is the only writer, so the reader cannot corrupt or
forge the signal it is judging. Written atomically — temp file in the same directory, then
`rename(2)` — because App reads this on every `/api/status`, and a half-written file would be a
parse error on a hot path. Mode `0644`, directory `0755`: the container runs as a different uid
and there is nothing secret in here.

## Shape

Flat, camelCase, no nesting — App reads it in TypeScript on a hot path and nested optionals buy
nothing here.

```json
{
  "schema": 1,
  "writtenAt": "2026-07-31T12:34:56Z",
  "beatSeconds": 5,
  "staleAfterSeconds": 30,
  "templateSeconds": 60,
  "templateStaleAfterSeconds": 360,
  "mode": "submit",
  "startedAt": "2026-07-31T11:02:03Z",
  "lastTemplateAt": "2026-07-31T12:34:54Z",
  "lastTemplateHeight": 4223019,
  "lastErrorStage": null,
  "lastErrorAt": null,
  "consecutiveErrors": 0,
  "solvedCount": 7,
  "lastSolvedAt": "2026-07-31T12:20:11Z",
  "submittedAccepted": 3,
  "submittedRejected": 0,
  "lastSubmittedAt": "2026-07-31T12:20:12Z"
}
```

Timestamps are RFC 3339 UTC with a `Z`. Anything that has not happened yet is `null`, never
absent: "has not happened" and "unknown" are different and `null` says which.

`lastErrorStage` and `lastErrorAt` are cleared to `null` the moment a beat succeeds, so a stale
error cannot sit in the panel after recovery. `consecutiveErrors` stays, because a miner flapping
between success and failure is invisible if you only keep the latest state.

**The writer publishes the thresholds, not just the intervals.** `staleAfterSeconds` and
`templateStaleAfterSeconds` are computed by the writer from its own configuration, so the reader
compares an age to a number in the file and neither side picks a multiplier. App proposed 3× and
I had written 6×; rather than agree on a constant that then lives in two places and drifts, the
number lives once, here, next to the thing it describes.

## How to read it: four states, none of them a boolean

Let `age(x) = now - x`.

| condition | state | meaning |
| --- | --- | --- |
| file absent, unreadable, unparseable, or `schema` unrecognised | `cannot-verify` | **Not "off".** We learned nothing. |
| `age(writtenAt) > staleAfterSeconds` | `not-writing` | The miner is not beating: unit stopped, wedged, or disk full. |
| `lastTemplateAt` is null, or `age(lastTemplateAt) > templateStaleAfterSeconds` | `stalled` | **The failure that hid for 70 minutes.** Alive and beating, not getting templates. |
| otherwise | `running` | Beating and fetching templates. |

`startedAt` exists so the panel can word `stalled` honestly when `lastTemplateAt` is null: "started
40 seconds ago, no template yet" and "up an hour, never fetched a template" are the same two
fields otherwise, and only the second is a fault. It **explains** the state, it does not excuse
it — a null `lastTemplateAt` is never `running`, and that is a choice we made rather than fell
into: a miner restart does show `stalled` briefly, which is the fail-loud direction and agreed
with App.

`cannot-verify` must never render as healthy and never as "mining off" — three different claims,
and collapsing them into one boolean is how we got here. State comes from the **timestamps**, not
from `consecutiveErrors`: a counter can read zero while nothing works.

## Two things this file deliberately does NOT carry

**No `configured` flag.** App asked for the miner's copy of the env flag so the panel could say
"off, deliberately" without reading env separately. Declined, because the miner does not see
`FAUCET_MINER_ACTIVE` — that variable belongs to the faucet container — so the miner would be
asserting a flag it cannot observe, which is the original bug wearing a different hat. Intent and
reality are different facts and should come from different sources: App already has the env var in
its own process for "configured", and this file is only ever observed reality. `mode` is here
instead, because the miner *does* own that, and it changes what "running" means: a miner in
`proposal` mode never submits.

**No error messages.** `lastErrorStage` is a short fixed token — `getblocktemplate`, `submitblock`,
`solve` — never the message text. This is served from a public endpoint, and a raw error string is
exactly where an RPC URL with credentials in its userinfo ends up. Also never in this file: the
RPC URL itself, and the cookie path or its contents.

## Compatibility

`schema` is an integer, bumped only on a breaking change. A reader that does not recognise the
value reports `cannot-verify` rather than guessing at fields. Adding a nullable field is not
breaking and does not bump it.
