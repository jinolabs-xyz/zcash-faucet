/**
 * Subnet derivation for the Sybil cap (#196).
 *
 * The property that actually matters is that two DIFFERENT WRITTEN FORMS of the same
 * network produce the same key. A textual prefix match would pass a naive test and
 * then let a farmer vary the spelling to dodge the grouping, which is why the v6
 * cases below are mostly about equivalence rather than about parsing.
 *
 * The other half is that an unparseable input yields null. That skips the rule for
 * one request, which loses a defence. Inventing a fallback key instead would put
 * every unparseable client in one shared bucket and make real users block each other,
 * which is worse than the farm we are trying to stop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RATE_LIMIT_SALT = "subnet-test-salt";
const { subnetOf, fingerprintSubnet, fingerprintIp } = await import("./privacy.ts");

test("IPv4 groups by /24, so the 256 hosts on a block share a key", () => {
  assert.equal(subnetOf("203.0.113.45"), "203.0.113.0/24");
  assert.equal(subnetOf("203.0.113.1"), "203.0.113.0/24");
  assert.equal(subnetOf("203.0.113.254"), "203.0.113.0/24");
  // A neighbouring block is a different key, or the cap would span unrelated networks.
  assert.notEqual(subnetOf("203.0.114.1"), subnetOf("203.0.113.1"));
});

test("the IPv4-mapped IPv6 form some proxies emit lands on the same /24", () => {
  // Otherwise the same client would occupy two buckets depending on which proxy
  // handled it, and the cap would count them separately.
  assert.equal(subnetOf("::ffff:203.0.113.45"), "203.0.113.0/24");
  assert.equal(subnetOf("::ffff:203.0.113.45"), subnetOf("203.0.113.45"));
});

test("IPv6 groups by /64, because a single host owns a whole one", () => {
  assert.equal(subnetOf("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  // Anything inside that /64 is the same host as far as abuse goes.
  assert.equal(subnetOf("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
});

test("DIFFERENT WRITTEN FORMS of one network agree, which a prefix match would fail", () => {
  // The whole reason expandIpv6 exists. All four spell the same /64.
  const forms = [
    "2001:db8::1",
    "2001:0db8:0000:0000:0000:0000:0000:0001",
    "2001:db8:0:0::1",
    "2001:0db8::0001",
  ];
  const keys = new Set(forms.map((f) => subnetOf(f)));
  assert.equal(keys.size, 1, `these should all be one subnet, got ${[...keys].join(" | ")}`);
  assert.equal([...keys][0], "2001:db8:0:0::/64");
});

test("a different /64 in the same /48 is a different key", () => {
  // If these collided, the /64 choice would be doing nothing.
  assert.notEqual(subnetOf("2001:db8:1:2::1"), subnetOf("2001:db8:1:3::1"));
});

test("unparseable input yields null, which SKIPS the rule rather than inventing a bucket", () => {
  for (const bad of ["", "   ", "not-an-ip", "999.1.1.1", "203.0.113", "2001:db8::1::2", "::ffff:999.1.1.1", "gggg::1"]) {
    assert.equal(subnetOf(bad), null, `${JSON.stringify(bad)} should not produce a subnet`);
  }
  assert.equal(fingerprintSubnet("not-an-ip"), null);
});

test("the fingerprint is domain-separated from the IP one", () => {
  // Without the separate tag, a subnet string and an IP string that happened to be
  // equal would collide across two columns that mean different things.
  const ip = "203.0.113.0/24";
  assert.notEqual(fingerprintSubnet("203.0.113.45"), fingerprintIp(ip));
});

test("the fingerprint is 128 bits of hex and never the plaintext", () => {
  const f = fingerprintSubnet("203.0.113.45");
  assert.ok(f);
  assert.match(f, /^[0-9a-f]{32}$/);
  assert.ok(!f.includes("203"), "the subnet must not survive in the fingerprint");
});

test("it is COARSER than the IP hash, which is the privacy claim", () => {
  // Two different hosts on one block share a subnet key and differ by IP key. If this
  // ever inverted, the column would be more identifying than the one it sits beside
  // and the whole privacy-positive argument for it would be false.
  const a = "203.0.113.10";
  const b = "203.0.113.200";
  assert.equal(fingerprintSubnet(a), fingerprintSubnet(b), "same block must share a subnet key");
  assert.notEqual(fingerprintIp(a), fingerprintIp(b), "different hosts must differ by IP key");
});
