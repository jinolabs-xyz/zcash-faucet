/**
 * Every case here is a shape I actually observed from a live explorer today, not an
 * invented edge. The two that matter most are the ones that look like clean
 * negatives and are not: a 404 for a real transaction, and a tidy all-zeros body.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { askOneSource, confirmExternally, type ExternalSource } from "./payoutExternal.ts";

const TXID = "bb328dba1c743d0810990e932652a01c89507bca50b71f3e7327f0810cdfe2cb";
const OTHER = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const src = (org: string): ExternalSource => ({ org, url: () => `https://example.invalid/${org}` });

/** A fetch that returns one canned response, so each case tests one shape. */
function canned(status: number, body: string): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

test("a mined height plus the right txid is the only thing that confirms", async () => {
  const s = await askOneSource(TXID, src("a"), 500, canned(200, JSON.stringify({ txid: TXID, blockHeight: 4221730 })));
  assert.equal(s.state, "confirmed");
  assert.equal(s.height, 4221730);
});

test("a 404 is NOT absent, because a real txid 404s when the host is unwell", async () => {
  // Measured: cipherscan served this exact 404 for a txid it had described correctly
  // minutes before. Reading it as a negative reports a successful payout as missing.
  const s = await askOneSource(TXID, src("a"), 500, canned(404, "<!DOCTYPE html><html>not found</html>"));
  assert.equal(s.state, "cannot-verify");
  assert.match(s.detail, /not a negative/);
});

test("200 with an HTML error page is not a negative either", async () => {
  const s = await askOneSource(TXID, src("a"), 500, canned(200, "<!DOCTYPE html><html>oops</html>"));
  assert.equal(s.state, "cannot-verify");
  assert.match(s.detail, /not JSON/);
});

test("a tidy all-zeros body proves nothing, which is the fabricated-dataset case", async () => {
  // The shape cipherscan returns for an address that has never existed: HTTP 200,
  // well-formed, every field zero. It looks machine-checked, so it is more
  // persuasive than an HTML page and more dangerous.
  const s = await askOneSource(TXID, src("a"), 500, canned(200, JSON.stringify({ txid: TXID, blockHeight: 0, confirmations: 0 })));
  assert.equal(s.state, "cannot-verify");
  assert.match(s.detail, /proves nothing/);
});

test("a source answering about a DIFFERENT transaction is refused", async () => {
  const s = await askOneSource(TXID, src("a"), 500, canned(200, JSON.stringify({ txid: OTHER, blockHeight: 999 })));
  assert.equal(s.state, "cannot-verify");
  assert.match(s.detail, /different transaction/);
});

test("only an EXPLICIT negative earns absent", async () => {
  const s = await askOneSource(TXID, src("a"), 500, canned(200, JSON.stringify({ status: "not_found" })));
  assert.equal(s.state, "absent");
});

test("a timeout is cannot-verify, not absent", async () => {
  const hang: typeof fetch = (async () => {
    await new Promise((r) => setTimeout(r, 50));
    throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
  }) as unknown as typeof fetch;
  const s = await askOneSource(TXID, src("a"), 10, hang);
  assert.equal(s.state, "cannot-verify");
});

test("a non-txid is refused before any request is made", async () => {
  let called = false;
  const spy: typeof fetch = (async () => {
    called = true;
    return new Response("{}");
  }) as unknown as typeof fetch;
  const s = await askOneSource("not-a-txid", src("a"), 500, spy);
  assert.equal(s.state, "cannot-verify");
  assert.equal(called, false, "must not ask an explorer about a malformed txid");
});

test("ONE source confirming is enough to confirm, when nothing contradicts it", async () => {
  const v = await confirmExternally(TXID, [src("a"), src("b")], 500, canned(200, JSON.stringify({ txid: TXID, blockHeight: 42 })));
  assert.equal(v.state, "confirmed");
  assert.equal(v.height, 42);
});

test("ONE source is NOT enough to declare a payout missing", async () => {
  // The asymmetry is the whole design: "the network never saw it" pages a human, so
  // a single flaky explorer must not be able to raise it alone.
  let n = 0;
  const mixed: typeof fetch = (async () => {
    n += 1;
    return n === 1
      ? new Response(JSON.stringify({ status: "not_found" }), { status: 200 })
      : new Response("<html>down</html>", { status: 503 });
  }) as unknown as typeof fetch;
  const v = await confirmExternally(TXID, [src("a"), src("b")], 500, mixed);
  assert.equal(v.state, "cannot-verify");
});

test("both sources explicitly missing IS absent, because that is the real alarm", async () => {
  const v = await confirmExternally(TXID, [src("a"), src("b")], 500, canned(200, JSON.stringify({ status: "not_found" })));
  assert.equal(v.state, "absent");
});

test("sources disagreeing on height is cannot-verify, not confirmed", async () => {
  // Two nodes on opposite sides of a split both answer confidently. Picking the
  // first would launder a fork into a confirmation.
  let n = 0;
  const disagree: typeof fetch = (async () => {
    n += 1;
    return new Response(JSON.stringify({ txid: TXID, blockHeight: n === 1 ? 100 : 200 }), { status: 200 });
  }) as unknown as typeof fetch;
  const v = await confirmExternally(TXID, [src("a"), src("b")], 500, disagree);
  assert.equal(v.state, "cannot-verify");
  assert.match(v.detail, /disagree on height/);
});

test("a confirmation alongside an explicit negative is cannot-verify", async () => {
  let n = 0;
  const split: typeof fetch = (async () => {
    n += 1;
    return n === 1
      ? new Response(JSON.stringify({ txid: TXID, blockHeight: 7 }), { status: 200 })
      : new Response(JSON.stringify({ status: "not_found" }), { status: 200 });
  }) as unknown as typeof fetch;
  const v = await confirmExternally(TXID, [src("a"), src("b")], 500, split);
  assert.equal(v.state, "cannot-verify");
});

test("every sighting is reported, so a disagreement can be attributed", async () => {
  const v = await confirmExternally(TXID, [src("a"), src("b")], 500, canned(500, "nope"));
  assert.equal(v.sightings.length, 2);
  assert.deepEqual(v.sightings.map((s) => s.source), ["a", "b"]);
});

test("a height with no txid echo says so, instead of claiming there was no height", async () => {
  // Found reviewing #236, measured against the merged module: this input returned
  // "no height and no explicit negative", which is false. The verdict was right and
  // the sentence was not, which is the #211 defect in a different file.
  //
  // The case is not hypothetical: an explorer returning blockHeight without echoing
  // txid is the shape a generic or cached body has, and that is the one this module
  // most needs to describe accurately.
  const s = await askOneSource(TXID, src("a"), 500, canned(200, JSON.stringify({ blockHeight: 4221730 })));
  assert.equal(s.state, "cannot-verify", "a height alone must not confirm");
  assert.doesNotMatch(s.detail, /no height/, `still claims there was no height: ${s.detail}`);
  assert.match(s.detail, /never named the transaction/);
  assert.match(s.detail, /4221730/, "the height it did report belongs in the reason");
});

test("a genuinely blank answer still gets the blank-answer reason", async () => {
  // The control. Without it, giving both paths the same new sentence would pass the
  // test above while losing the distinction it exists to make.
  const s = await askOneSource(TXID, src("a"), 500, canned(200, JSON.stringify({ txid: TXID })));
  assert.equal(s.state, "cannot-verify");
  assert.match(s.detail, /no height and no explicit negative/);
});
