/**
 * Did the network actually record a payout we believe we made?
 *
 * The internal half (txstatus.ts) asks our own wallet. That is necessary and not
 * sufficient: the failure this exists for is tx 29 on 2026-07-29, where we built a
 * shield, believed we had sent it, and the network never recorded it — its expiry
 * height had already been mined four seconds before it was created. Nothing noticed
 * for seven hours. Our node cannot report that failure, because our node is the
 * thing that would have to be wrong.
 *
 * So this asks somebody else, and it is built around two measured facts about
 * public explorers rather than around how they are documented.
 *
 * FACT ONE: they answer for things that do not exist. `testnet.cipherscan.app`
 * returns HTTP 200 with a well-formed all-zeros body for an address never seen on
 * chain — a fabricated DATASET, not merely a rendered page, and JSON reads as more
 * authoritative than HTML precisely because it looks machine-checked. So absence of
 * data is never evidence of absence from the chain.
 *
 * FACT TWO: they fail in ways that look like a clean negative. The same host
 * intermittently 308-redirects to a 404 HTML page — for a txid that had answered
 * correctly moments earlier. Read carelessly, "404" means "the network never saw
 * your payment", which is a completely different emergency from "the explorer is
 * having a bad minute".
 *
 * Hence: POSITIVE EVIDENCE ONLY, and three states everywhere.
 */

/** `absent` is a claim about the CHAIN. `cannot-verify` is a claim about the LOOKUP. */
export type ExternalState = "confirmed" | "absent" | "cannot-verify";

export interface ExternalSighting {
  state: ExternalState;
  /** Only ever set when state is "confirmed". */
  height: number | null;
  /** Which org answered, so a disagreement can be attributed. */
  source: string;
  /** Why, in words, for the log line a human will actually read. */
  detail: string;
}

export interface ExternalSource {
  /** Org name, not hostname: two hosts from one org are not two sources. */
  org: string;
  /** Given a txid, the URL that should return JSON describing it. */
  url: (txid: string) => string;
}

/**
 * ONE source, deliberately, and the shortfall is stated rather than papered over.
 *
 * `testnet.zcashexplorer.app` was meant to be the second org. Measured: it has no
 * JSON transaction API at all — /api/v1/tx, /api/tx, /api/transactions and
 * /api/v1/transaction all return 404 with `content-type: application/json`, so the
 * 404 is the API's real answer rather than an HTML fallback. Its HTML page does carry
 * the height, and did return it once, but minutes later the same URL 404'd for the
 * same confirmed txid.
 *
 * Listing it anyway would have been worse than omitting it: a source that can only
 * ever answer `cannot-verify` looks like diversity in the config and provides none,
 * and — see the combination rule below — it would have made `absent` permanently
 * unreachable while appearing to strengthen the check.
 *
 * Not zec.rocks either: our own node's lightwalletd backend is zec.rocks, and
 * agreement with our own upstream is not independent confirmation.
 */
export const DEFAULT_SOURCES: ExternalSource[] = [
  { org: "cipherscan", url: (t) => `https://testnet.cipherscan.app/api/tx/${t}` },
];

/**
 * WHAT THIS MODULE CANNOT DO, and it is the half #202 was actually filed for.
 *
 * With one source, and with every source we have measured being intermittent, the
 * `absent` verdict is effectively unreachable: an explorer that is unwell answers
 * `cannot-verify`, never "no such transaction". So this can CONFIRM a payout landed
 * and it cannot RAISE THE ALARM that one did not.
 *
 * That is the correct behaviour for evidence this weak — but it means explorer
 * silence is the wrong signal to build the alarm on, and pursuing a second flaky
 * explorer would not fix it either.
 *
 * The right signal is arithmetic we can verify ourselves. tx 29 did not fail in a way
 * an explorer could describe; it failed because its expiry height had ALREADY BEEN
 * MINED four seconds before it was created, so it could never be included. That is
 * deterministic: once our own tip passes a transaction's expiry height and the
 * transaction is not in a block, it is dead — no external opinion required, and no
 * flakiness to reason about.
 *
 * So the alarm belongs on `tip > expiryHeight && !confirmed`, and this module is the
 * corroboration half rather than the detection half. Recorded on #202 rather than
 * silently half-built.
 */
export const ALARM_NEEDS_EXPIRY_CHECK = true;

const TXID_RE = /^[0-9a-f]{64}$/i;

/**
 * A browser User-Agent, because at least one of these hosts serves 403 to a bare
 * curl-style agent. Not cleverness: without it the check reports cannot-verify
 * forever and looks like the sources are down.
 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

function unverifiable(source: string, detail: string): ExternalSighting {
  return { state: "cannot-verify", height: null, source, detail };
}

/**
 * Ask one source. Never throws: every failure is a `cannot-verify` carrying its
 * reason, because a thrown exception at a call site tends to become a caught-and-
 * ignored nothing, and "we could not check" must survive to the report.
 */
export async function askOneSource(
  txid: string,
  source: ExternalSource,
  timeoutMs = 8000,
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalSighting> {
  if (!TXID_RE.test(txid)) return unverifiable(source.org, "not a txid, refusing to ask");

  let res: Response;
  try {
    res = await fetchImpl(source.url(txid), {
      headers: { accept: "application/json", "user-agent": UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return unverifiable(source.org, `no answer (${e instanceof Error ? e.name : "error"})`);
  }

  // A 404 is NOT "absent". Measured: this host 404s a real, confirmed txid when it
  // is having a bad minute, and the body is an HTML page identical to the one it
  // serves for an invented txid. Treating that as a negative would report someone's
  // successful payout as never having happened.
  if (!res.ok) return unverifiable(source.org, `HTTP ${res.status}, which is not a negative`);

  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // The 404-HTML case arrives here when a host returns 200 with an error page.
    return unverifiable(source.org, "answered with something that is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return unverifiable(source.org, "JSON that is not an object");
  }

  const d = parsed as Record<string, unknown>;

  // The echo check. A source that hands back a generic, cached or mismatched body
  // would otherwise let one transaction's confirmation stand in for another's, and
  // that is exactly the mistake this module exists to prevent, made by the module.
  const echoed = typeof d.txid === "string" ? d.txid : typeof d.hash === "string" ? d.hash : null;
  if (echoed !== null && echoed.toLowerCase() !== txid.toLowerCase()) {
    return unverifiable(source.org, `answered about a different transaction (${echoed.slice(0, 12)}…)`);
  }

  const height = typeof d.blockHeight === "number" ? d.blockHeight : typeof d.height === "number" ? d.height : null;

  // POSITIVE EVIDENCE: a mined height, and the source naming the transaction we
  // asked about. Everything short of that is unverifiable, INCLUDING a tidy body
  // full of zeros and nulls — that is the fabricated-dataset case, and it is the
  // one most likely to be mistaken for a clean negative.
  if (height !== null && height > 0 && echoed !== null) {
    return { state: "confirmed", height, source: source.org, detail: `mined at ${height}` };
  }

  // An EXPLICIT negative is the only thing that earns "absent": the source has to
  // say the transaction is unknown, not merely fail to describe it.
  const status = typeof d.status === "string" ? d.status.toLowerCase() : "";
  const explicitlyMissing =
    d.found === false || status === "not_found" || status === "notfound" || status === "unknown";
  if (explicitlyMissing) {
    return { state: "absent", height: null, source: source.org, detail: "source says it has no such transaction" };
  }

  return unverifiable(source.org, "no height and no explicit negative, so this proves nothing");
}

export interface ExternalVerdict {
  state: ExternalState;
  height: number | null;
  sightings: ExternalSighting[];
  detail: string;
}

/**
 * Ask every source and combine. The combination rule is deliberately timid, because
 * the two verdicts are not symmetric in cost:
 *
 *   confirmed  needs at least one source with positive evidence and NO source
 *              contradicting it.
 *   absent     needs EVERY source to say so explicitly, and at least two, because
 *              "the network never recorded our payment" is a page-a-human claim and
 *              one flaky explorer must never be able to raise it alone.
 *
 * Anything else is cannot-verify, which is a real answer and must be reported as
 * itself rather than rounded to whichever neighbour is convenient.
 */
export async function confirmExternally(
  txid: string,
  sources: ExternalSource[] = DEFAULT_SOURCES,
  timeoutMs = 8000,
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalVerdict> {
  const sightings = await Promise.all(sources.map((s) => askOneSource(txid, s, timeoutMs, fetchImpl)));

  const confirmed = sightings.filter((s) => s.state === "confirmed");
  const absent = sightings.filter((s) => s.state === "absent");

  // Disagreement about the height means one of them is wrong about which chain it
  // is on, and we cannot tell which. That is not a confirmation.
  const heights = new Set(confirmed.map((s) => s.height));
  if (heights.size > 1) {
    return {
      state: "cannot-verify",
      height: null,
      sightings,
      detail: `sources disagree on height (${[...heights].join(" vs ")})`,
    };
  }

  if (confirmed.length > 0 && absent.length === 0) {
    return {
      state: "confirmed",
      height: confirmed[0].height,
      sightings,
      detail: `confirmed by ${confirmed.map((s) => s.source).join(", ")}`,
    };
  }

  if (absent.length >= 2 && absent.length === sightings.length) {
    return {
      state: "absent",
      height: null,
      sightings,
      detail: `every source (${absent.map((s) => s.source).join(", ")}) says it has no such transaction`,
    };
  }

  return {
    state: "cannot-verify",
    height: null,
    sightings,
    detail: sightings.map((s) => `${s.source}: ${s.detail}`).join("; "),
  };
}
