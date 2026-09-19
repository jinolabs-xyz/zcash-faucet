import { test } from "node:test";
import assert from "node:assert/strict";
import { basePhase, faultReason, holding, nodeGap, type Status } from "./faucetPhase.ts";

/**
 * #573: the phase machine's first unit test. It lived inside page.tsx as a useCallback, so the
 * only thing exercising it was a 6-state browser sweep (scripts/phase-sweep.mjs) whose own header
 * points at a line range that has since moved. One row per branch, each named for the branch.
 */
const ok: Status = {
  sender: "zallet", empty: false, balanceTaz: 100,
  backend: { reachable: true },
  node: { ready: true, frozen: false, canBuildTx: true },
} as unknown as Status;
const w = (patch: Partial<Status>): Status => ({ ...ok, ...patch } as Status);

test("#573: no status at all is 'checking' - we have not asked, which is not a finding", () => {
  assert.equal(basePhase(null), "checking");
});

test("#573: a fault outranks a sync, so a frozen node never narrates as first sync (R-33)", () => {
  assert.equal(basePhase(w({ node: { ready: false, frozen: true } } as Partial<Status>)), "fault");
});

test("#573: a node genuinely catching up is 'syncing'", () => {
  assert.equal(basePhase(w({ node: { ready: false, frozen: false, canBuildTx: true } } as Partial<Status>)), "syncing");
});

test("#573: an unreadable balance is never 'empty' - unknown is not zero, and which fault it is depends on WHO cannot answer", () => {
  // The syncing branch needs no node block AND a sender the node status does not apply to.
  // I wrote this row expecting plain "syncing" and the machine corrected me: with zallet the
  // wallet not answering is a FAULT, which is the distinction #522 was about.
  assert.equal(basePhase(w({ sender: "lightwallet", node: null, balanceTaz: null } as Partial<Status>)), "syncing");
  assert.equal(basePhase(w({ balanceTaz: null } as Partial<Status>)), "fault");
  assert.equal(basePhase(w({ node: null, balanceTaz: null } as Partial<Status>)), "fault");
  assert.match(faultReason(w({ balanceTaz: null } as Partial<Status>))!, /cannot read our wallet's balance/);
  assert.match(faultReason(w({ node: null, balanceTaz: null } as Partial<Status>))!, /wallet is not answering/);
});

test("#573: a zero balance is 'empty', and so is the explicit empty flag", () => {
  assert.equal(basePhase(w({ balanceTaz: 0 } as Partial<Status>)), "empty");
  assert.equal(basePhase(w({ empty: true } as Partial<Status>)), "empty");
});

test("#573: a DEFINITE degraded send verdict closes the faucet; 'unknown' does not", () => {
  assert.equal(basePhase(w({ sends: { state: "degraded" } } as Partial<Status>)), "degraded");
  assert.equal(basePhase(w({ sends: { state: "unknown" } } as Partial<Status>)), "ready");
});

test("#573: everything answering is 'ready'", () => {
  assert.equal(basePhase(ok), "ready");
});

/* cTAZ returns before every TAZ rule, because none of them is about their node. */
test("#573: cTAZ asks only its own recency gate, and is never 'empty'", () => {
  const off = w({ ctaz: { enabled: false } } as Partial<Status>);
  assert.equal(basePhase(off, "ctaz"), "syncing");
  assert.equal(basePhase(w({ ctaz: { enabled: true, servable: true } } as Partial<Status>), "ctaz"), "ready");
  assert.equal(basePhase(w({ ctaz: { enabled: true, servable: false } } as Partial<Status>), "ctaz"), "syncing");
});

test("#573: a broken TAZ wallet does not decide cTAZ - the questions are different", () => {
  const brokenTaz = w({ balanceTaz: 0, backend: { reachable: false }, ctaz: { enabled: true, servable: true } } as Partial<Status>);
  assert.equal(basePhase(brokenTaz, "taz"), "fault");
  assert.equal(basePhase(brokenTaz, "ctaz"), "ready", "cTAZ read a TAZ fault as its own");
});

/* faultReason names the component, so the sentence is never "the node" when it is the wallet. */
test("#573: each fault names its own component", () => {
  assert.match(faultReason(w({ backend: { reachable: false } } as Partial<Status>))!, /indexer/);
  // balanceTaz too: a missing node reading alone is our deadline, not the wallet's silence (#704).
  assert.match(faultReason(w({ node: null, balanceTaz: null } as Partial<Status>))!, /wallet is not answering/);
  assert.match(faultReason(w({ node: { frozen: true } } as Partial<Status>))!, /stopped following|blocks behind/);
  assert.equal(faultReason(ok), null, "a healthy stack must name no fault");
});

test("#573: a node we cannot verify is refused differently from one measurably behind", () => {
  const unsafe = w({ node: { ready: true, canBuildTx: false, shield: { state: "unsafe", lag: 44 } } } as Partial<Status>);
  const unverifiable = w({ node: { ready: true, canBuildTx: false, shield: { state: "unverifiable", lag: null } } } as Partial<Status>);
  assert.match(faultReason(unsafe)!, /44 blocks behind/);
  assert.match(faultReason(unverifiable)!, /cannot verify/);
});

test("#573: nodeGap is null unless both heights are known and ours is behind", () => {
  assert.equal(nodeGap(w({ node: { externalHeight: 100, nodeHeight: 90 } } as Partial<Status>)), 10);
  assert.equal(nodeGap(w({ node: { externalHeight: null, nodeHeight: 90 } } as Partial<Status>)), null);
  assert.equal(nodeGap(w({ node: { externalHeight: 90, nodeHeight: 100 } } as Partial<Status>)), null);
});

test("#573: holding() is the 'cannot send yet' set, and 'checking' is in it", () => {
  for (const p of ["checking", "syncing", "fault"] as const) assert.equal(holding(p), true, p);
  for (const p of ["ready", "empty", "degraded", "queued"] as const) assert.equal(holding(p), false, p);
});

test("#704: our own deadline expiring is not the wallet's silence", () => {
  // The page gives the node read 4-6s; the balance call gets 15s against the SAME wallet RPC,
  // so every wallet reply in that band lands here as node:null with a balance beside it.
  // Announcing an outage over it told roughly one visitor in nine that the faucet was down.
  const s = w({ node: null, balanceTaz: 4504.7 } as Partial<Status>);
  assert.equal(faultReason(s), null, "a balance from that wallet outranks our timeout");
  // NOT "ready" either. No reading is not a good reading, and a ready button here invites a
  // proof of work that the claim path's own fresh read may then refuse (#457).
  assert.equal(basePhase(s), "checking");
  assert.equal(holding(basePhase(s)), true, "and sends are held while we do not know");
});

test("#704: the real outage still reports, which is what stops the fix going too far", () => {
  // Both halves silent is the zallet crash-loop the branch was written for. A fix that simply
  // stopped faulting on a missing node would satisfy the row above and delete this one.
  const s = w({ node: null, balanceTaz: null } as Partial<Status>);
  assert.equal(faultReason(s), "our wallet is not answering");
  assert.equal(basePhase(s), "fault");
});
