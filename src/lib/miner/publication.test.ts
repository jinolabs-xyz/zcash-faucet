/**
 * THE SEAM #679 BUILT, CHECKED WHERE IT IS ACTUALLY LOAD-BEARING.
 *
 * #679 nested the operator fields and added `publicMinerView`, so that reading a field and
 * PUBLISHING it stopped being the same action. The compiler enforces that at every site that
 * destructures a reading - but only at sites that touch `.operator`. A page that takes the whole
 * object and forwards it compiles perfectly and ships the operator half to every visitor.
 *
 * SDE-Infra went looking for a second publication path when reviewing #679 and found one:
 * `src/app/donate/page.tsx` reads the heartbeat directly, outside `/api/status`, where the
 * projection does not reach. It was clean - two scalars, nothing forwarded - but Next serialises
 * server-component props to the client, so a future `<Shell miner={miner}>` there would leak the
 * operator half without anyone touching route.ts.
 *
 * Wrapping that call fixes the site. This file is the part that survives the next one: it fails
 * when a NEW reader of a raw heartbeat appears in the rendering layer, which is the edit nobody
 * would think to review. Deliberately NOT a hardcoded list of allowed files - a correct new reader
 * passes by being correct, and only an unwrapped one reds.
 *
 * Text-scanned rather than typechecked because the property being asserted is "the guard is
 * applied at the source", and a type test would need the leak to already exist to have something
 * to assert about. Comments are stripped first: a grep that matches commented-out code is a whole
 * afternoon this repo has already spent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../../app", import.meta.url));
/** The one file allowed to hold a RAW reading: it needs `.operator` for the ops-token branch. */
const OPS_ROUTE = join("api", "status", "route.ts");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/**
 * Block and line comments out, so neither a commented-out CALL nor a commented-out GUARD counts.
 *
 * BLANKED, NOT DELETED, and that is not tidiness. Deleting them shifts every line after a comment,
 * so the row reports a line number that does not exist in the file a reader then opens - measured:
 * it named donate/page.tsx:37 for a call on :49. A guard that misdirects is worse than one that
 * only names the file. Replacing each comment with its own newlines keeps the offsets exact.
 */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^([ \t]*)\/\/.*$/gm, blank);
}

const files = walk(APP).map((p) => ({ rel: p.slice(APP.length + 1), src: stripComments(readFileSync(p, "utf8")) }));
const callers = files.filter((f) => f.src.includes("readMinerHeartbeat("));

test("the scan can see the call sites at all, or every row below is vacuous", () => {
  // ANTI-VACUITY. Rename the function, move the directory, or break the walk, and every assertion
  // below passes over an empty list. This is the row that notices.
  assert.ok(
    callers.length >= 2,
    `found ${callers.length} file(s) calling readMinerHeartbeat under src/app: ${JSON.stringify(callers.map((c) => c.rel))}`,
  );
  assert.ok(
    callers.some((c) => c.rel === OPS_ROUTE),
    `the ops route is expected to be one of them; saw ${JSON.stringify(callers.map((c) => c.rel))}`,
  );
});

test("outside the ops route, nothing reads a raw miner heartbeat - the public view wraps every call", () => {
  const unguarded: string[] = [];
  for (const f of callers) {
    if (f.rel === OPS_ROUTE) continue;
    // Every occurrence, not the first: a file may read it twice and only one be wrapped.
    for (const m of f.src.matchAll(/readMinerHeartbeat\(/g)) {
      const before = f.src.slice(0, m.index).trimEnd();
      if (!before.endsWith("publicMinerView(")) {
        const line = f.src.slice(0, m.index).split("\n").length;
        unguarded.push(`${f.rel}:${line}`);
      }
    }
  }
  assert.deepEqual(
    unguarded,
    [],
    `these read a raw heartbeat in the rendering layer, where Next serialises props to the client: ${JSON.stringify(unguarded)}`,
  );
});

test("and the ops route earns its exemption by projecting the public half itself", () => {
  // The exemption is not a free pass: route.ts holds the raw reading BECAUSE it serves the
  // operator half behind a token, and it must still project the public body through the same
  // function. Without this, "route.ts is allowed" would excuse a route that published everything.
  const route = callers.find((c) => c.rel === OPS_ROUTE);
  assert.ok(route, "the ops route was not found by the scan");
  assert.ok(
    route.src.includes("publicMinerView("),
    "route.ts holds the raw reading and must project the public body through publicMinerView",
  );
});
