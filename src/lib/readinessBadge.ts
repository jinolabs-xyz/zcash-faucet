/**
 * ONE OWNER OF THE READINESS WORD (#573).
 *
 * The index derived the badge from its phase machine; the subpages derived it on the client from
 * three separate facts (node ready, backend reachable, box ok). That is a FOURTH OPINION about
 * readiness, and it disagreed: on 2026-09-15, same stack and same second, a subpage rendered
 * NOT READY while the index rendered LIVE. A page that contradicts the page one click away is
 * worse than a page that says it has not looked.
 *
 * So the derivation lives here and both callers read it. This module MOVES the decision, it does
 * not change it - the index's phase machine still decides what phase the faucet is in, and the
 * test beside this file pins the word and the dot for every phase so a future edit has to mean it.
 *
 * AND `CHECKING_BADGE` IS DERIVED RATHER THAN WRITTEN. Shell.tsx used to hand-write it as
 * `{ word: "CHECKING", dot: { fill: "transparent", ring: "color-mix(in srgb, var(--color-text)
 * 45%, transparent)" } }` - byte-identical to what this function returns for the checking phase,
 * and a second copy nothing tied to the first. That is the untied-constant shape: change the
 * checking case here and the subpages would have kept the old one, silently.
 */

/** The faucet's phase, as the index's machine decides it. */
export type ReadinessPhase =
  | "checking" | "syncing" | "fault" | "queued" | "empty"
  | "degraded" | "ready" | "submitting" | "success" | "cooldown" | "error";

export interface ShellBadge {
  word: string;
  dot: { fill: string; ring: string };
}

export interface ReadinessInput {
  phase: ReadinessPhase;
  /** A claim is queued, but the thing it is waiting behind is a fault rather than a sync. */
  queuedBehindFault: boolean;
  /** The reserve is actively refilling, which is why "TOPPING UP" is not the same as "EMPTY". */
  refilling: boolean;
  /** The page's own "nothing is holding this" reading, used only for the dot. */
  live: boolean;
}

/** `color-mix` against the text colour, which is how this page spells a muted ink. */
export const mutedInk = (pct: number): string =>
  `color-mix(in srgb, var(--color-text) ${pct}%, transparent)`;

const EMPTY_DOT = { fill: "var(--color-empty)", ring: "var(--color-empty)" };

/**
 * The word and the dot for one reading of the faucet.
 *
 * Honest badge: "TOPPING UP" only when a refill is actually running, "EMPTY" when it is not; a
 * refill with the balance still serviceable stays "LIVE". Queued is a syncing node with a claim
 * held, so it reads PREPARING too - unless what it is queued behind is a fault.
 *
 * Colour carries the state and red means what red means. It is redundant with the word and with
 * the status region, and never the only signal.
 */
export function readinessBadge(input: ReadinessInput): ShellBadge {
  const { phase, queuedBehindFault, refilling, live } = input;
  const faulted = phase === "fault" || (phase === "queued" && queuedBehindFault);

  const word =
    phase === "checking"
      ? "CHECKING"
      : faulted
        ? "NOT READY"
        : phase === "syncing" || phase === "queued"
          ? "PREPARING"
          : phase === "empty"
            ? (refilling ? "TOPPING UP" : "EMPTY")
            : phase === "degraded"
              ? "DEGRADED"
              : "LIVE";

  const dot =
    phase === "empty"
      ? refilling
        ? { fill: "var(--color-accent)", ring: "var(--color-accent)" } // topping up, calm
        : EMPTY_DOT // genuinely empty
      : phase === "degraded" || faulted
        ? EMPTY_DOT // a fault, and red means what red means
        : live
          ? { fill: "var(--color-live)", ring: "var(--color-live)" }
          : { fill: "transparent", ring: mutedInk(45) }; // syncing, no alarm

  return { word, dot };
}

/**
 * MOVED FROM Shell.tsx WITH THE CONSTANT (#573), because the ruling belongs beside the thing
 * it rules on.
 *
 * "CHECKING", NEVER "NOT READY", AND THIS IS A RULING RATHER THAN A PREFERENCE (CTO,
 * 21:13Z). The snapshot's static subpage markup ships `data-state="UNKNOWN"` with the words
 * NOT READY, and as a first paint to someone reading the terms with JavaScript disabled
 * that is a false claim about a service that may be perfectly healthy - the same class as a
 * sync figure reading 100% while 44 blocks behind, which is exactly what production did at
 * 20:38Z tonight.
 *
 * The ruling's better branch - render the TRUE word on the server - needs a status read
 * that does not block on the network, and there is none today: `pingBackend` is a live gRPC
 * round trip with no cache layer, `getNodeStatus` has none either, and this repo's own
 * recorded figure is a 2 ms page against 460 to 770 ms for `/api/status`. Putting that in
 * front of a legal page that currently renders from config alone loses to the ruling's own
 * priority: readability of the terms page outranks a live badge. The precondition for the
 * follow-up is an in-process status snapshot cache, which is its own change.
 *
 * The dot is TRANSPARENT with a muted ring, which is the page's existing "no alarm, nothing
 * established" pose, so the colour does not assert health either.
 */
/**
 * What a page renders before it has looked - and what a subpage renders for a reader with no
 * JavaScript, per the CTO ruling of 2026-09-15 21:13Z: CHECKING, never NOT READY. Derived from
 * the function above so it cannot drift from the checking case it is supposed to be.
 */
export const CHECKING_BADGE: ShellBadge = readinessBadge({
  phase: "checking",
  queuedBehindFault: false,
  refilling: false,
  live: false,
});
