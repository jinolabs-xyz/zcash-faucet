// End-to-end API smoke test: drives the real claim flow over HTTP against a
// running server (mock sender + pow challenge). This is the integration check
// the unit tests cannot give us: route wiring, challenge issue/verify,
// rate-limit reservation and the send queue, all through the front door.
//
// Run it against a built server (never dev, it does not bundle):
//   FAUCET_SENDER=mock FAUCET_CHALLENGE=pow RATE_LIMIT_SALT=smoke PORT=3100 npm start
//   SMOKE_URL=http://localhost:3100 npm run smoke
//
// No dependencies: global fetch and node:crypto cover it.
import { createHash } from "node:crypto";

const BASE = process.env.SMOKE_URL ?? "http://localhost:3100";
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "ok" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures++;
};

// The validator does a real bech32m checksum decode (address.ts), so these
// are genuinely encoded vectors, not charset padding. Built the same way
// address.test.ts builds its fixtures, then pasted as literals to keep this
// script dependency-free:
//   bech32m.encode("utest", bech32m.toWords(seq(96, N)), 1023)  // N = 3, 41
// Mock mode validates the format and never sends, so the payload bytes only
// need to be correctly sized, not a spendable receiver.
const ADDR_A =
  "utest1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg37tfmf9tk2uup37w6hww86h3lrlsvrg5rv3zjvph8ez5c566v95x7anasj9e9xdq57htt0xretga3hlxah60kqsfzqt3uffvxvayzjz02ewkg6mj0xqg0r54ns6ly2rh";
const ADDR_C =
  "utest19ycrw0j9f3f45ctgdam8mpytj2v6pfawkk7v8jk3mr07dm05lvpqjyqhrcjjcve6g9yy74jav34hy7vqs78ft89r42cm307xeh2dhchf7rmlupgvzvdzz2p0xc75gj6jt9sxwmn40jpc4yvcn7n2md9mcg8qj85s";

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    for (let m = 0x80; m > 0; m >>= 1) {
      if (byte & m) return bits;
      bits++;
    }
    return bits;
  }
  return bits;
}

// Same scheme the pow worker solves in the browser: sha256("<seed>:<nonce>")
// with at least `difficulty` leading zero bits.
function solve({ seed, difficulty }) {
  for (let nonce = 0; ; nonce++) {
    const digest = createHash("sha256").update(`${seed}:${nonce}`).digest();
    if (leadingZeroBits(digest) >= difficulty) return String(nonce);
  }
}

async function getJson(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function claim(address, pow) {
  const res = await fetch(BASE + "/api/faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, ...(pow ? { pow } : {}) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function solvedChallenge() {
  const { status, body } = await getJson("/api/pow/challenge");
  if (status !== 200 || !body.seed) throw new Error(`challenge fetch failed: ${status}`);
  const started = Date.now();
  const nonce = solve(body);
  return { pow: { seed: body.seed, difficulty: body.difficulty, exp: body.exp, sig: body.sig, nonce }, ms: Date.now() - started, body };
}

// 1. The server is in the mode this test assumes.
const status = await getJson("/api/status");
ok("GET /api/status is 200", status.status === 200);
ok("challenge mode is pow", status.body.challenge === "pow", `got ${status.body.challenge}`);
ok("sender is mock", status.body.sender === "mock", `got ${status.body.sender}`);
if (failures) {
  console.log("server is not in mock+pow mode, aborting before the claim steps");
  process.exit(1);
}

// 2 + 3. A signed challenge arrives and is solvable.
const first = await solvedChallenge();
ok("challenge has seed/difficulty/exp/sig", !!(first.body.seed && first.body.difficulty && first.body.exp && first.body.sig));
ok(`solved ${first.body.difficulty} bits`, true, `${first.ms}ms`);

// 4. A claim with the solution goes through and returns a txid.
const A = ADDR_A;
const sent = await claim(A, first.pow);
ok("claim with pow returns 200 ok", sent.status === 200 && sent.body.ok === true, `status ${sent.status} ${JSON.stringify(sent.body.error ?? "")}`);
ok("claim returned a txid", typeof sent.body.txid === "string" && sent.body.txid.length >= 32);

// 5. The same address immediately again hits the cooldown, even with a fresh
// valid solution, so what 429s is the ledger and not the pow gate.
const second = await solvedChallenge();
const repeat = await claim(A, second.pow);
ok("immediate repeat claim is 429", repeat.status === 429, `status ${repeat.status}`);
ok("429 carries retryAfterSeconds", typeof repeat.body.retryAfterSeconds === "number");

// 6. No solution, different address: rejected by the pow gate before any
// rate-limit or send work happens.
const bare = await claim(ADDR_C, null);
ok("claim without pow is 403", bare.status === 403, `status ${bare.status}`);

console.log(failures === 0 ? "\nsmoke: all green" : `\nsmoke: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
