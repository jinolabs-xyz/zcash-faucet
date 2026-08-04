/**
 * THE WRITER'S OUTPUT, THROUGH THE READER. Nothing was doing this and it cost a bug.
 *
 * statusFile.test.ts checks the reader against hand-written fixtures. The shell script's own
 * failure paths were checked by running it. Both halves were verified alone and the PAIR
 * never was, so a greedy regex in the writer embedded the JSON-RPC envelope tail and produced
 * malformed JSON on the HAPPY PATH. The reader correctly called that absent, which means a
 * healthy node at tip would have rendered as unknown forever, and every test on both sides
 * stayed green.
 *
 * So this one runs the real script and feeds what it wrote to the real reader. No fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCtazStatusFile, statusIsStale } from "./statusFile.ts";

const REPO = new URL("../../..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "ctaz-roundtrip-"));

/** A curl the script will call instead of the real one. */
function stubCurl(mode: string): string {
  const p = join(dir, `curl-${mode}`);
  writeFileSync(p, `#!/usr/bin/env bash
case "${mode}" in
  good)    echo '{"jsonrpc":"2.0","result":{"blocks":293701,"estimatedheight":293701,"now_utc":1,"my_height":293701,"my_round":9,"my_locked_round":8,"finalizer_statuses":[1,2]},"error":null,"id":1}' ;;
  empty)   : ;;
  nofield) echo '{"jsonrpc":"2.0","result":{},"error":null,"id":1}' ;;
esac
`);
  chmodSync(p, 0o755);
  return p;
}

function run(mode: string) {
  const out = join(dir, `${mode}.json`);
  execFileSync("bash", [join(REPO, "deploy/z3/ctaz-status.sh")], {
    env: { ...process.env, CTAZ_CURL: stubCurl(mode), CTAZ_STATUS_OUT: out },
    stdio: "ignore",
  });
  return readCtazStatusFile(out);
}

test("THE HAPPY PATH ROUND-TRIPS, which is the case that was broken", () => {
  // The writer emitted `,"error":null,"id":1}` into the file from a greedy regex, so the
  // reader parsed nothing and returned absent. Everything looked healthy on both sides.
  const f = run("good");
  assert.equal(f.readable, true, "a good answer must survive the trip");
  assert.equal(f.blocks, 293_701);
  assert.equal(f.syncPercent, 100);
  assert.ok(f.at != null, "and it must carry a timestamp the reader can date");
  assert.equal(statusIsStale(f, Date.now()), false);
  assert.ok(f.recency && typeof f.recency === "object", "recency must arrive as an object, not a string");
});

test("an EMPTY body is not readable, which is what zaino flapping looks like", () => {
  // curl succeeds on an HTTP 200 with no body, so the first version wrote readable:true with
  // every figure null: it claimed the node answered when it answered with nothing.
  const f = run("empty");
  assert.equal(f.readable, false);
  assert.equal(f.syncPercent, null);
});

test("an answer missing blocks is not readable either", () => {
  const f = run("nofield");
  assert.equal(f.readable, false);
  assert.equal(f.blocks, null);
});
