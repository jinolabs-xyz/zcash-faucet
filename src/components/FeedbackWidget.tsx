"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MAX_FEEDBACK_BODY, MAX_FEEDBACK_REPLY_TO } from "@/lib/feedbackLimits";
import { feedbackSentence, QUEUED_SENTENCE, OFFLINE_SENTENCE } from "@/lib/feedbackCopy";

/**
 * The visitor's half of the feedback path (#683 shipped the other half).
 *
 * THE WORD IS "RECEIVED", NEVER "SENT", AND THAT IS THE WHOLE CONTRACT WITH THE ENDPOINT.
 * /api/feedback writes a row and answers 202; a timer on the box drains it to the operator
 * separately, and the public container has no egress at all - that seam is a security decision,
 * not a detail. So at the moment this form gets its answer, nothing has been delivered, and a
 * page saying "sent" would be claiming more than it knows. Same rule the rest of this codebase
 * spent the week on.
 *
 * FIVE FAILURE KINDS GET FIVE SENTENCES. route.ts distinguishes empty, too-long, rate, ledger and
 * bad-request; collapsing them into "something went wrong" would throw that work away at the last
 * step. A person who hit the daily limit and a person whose message is too long need to do
 * different things next.
 *
 * AND A FAILED SEND NEVER CLEARS THE BOX. The text stays exactly where it is on every error path
 * including a dead network, because the one unrecoverable outcome here is losing something a
 * person wrote. Only a 202 clears it.
 */

type Outcome =
  | { kind: "none" }
  | { kind: "queued" }
  | { kind: "error"; message: string };

const BUSY = "Sending";

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
  const panelId = useId();
  const launcher = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  // Focus into the box on open and back to the launcher on close: a control that opens something
  // and leaves the keyboard behind is a control a keyboard user cannot actually use.
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        launcher.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setOutcome({ kind: "none" });
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, replyTo: replyTo.trim() ? replyTo.trim() : undefined }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 202 && data?.ok) {
        // The ONLY path that clears the box.
        setBody("");
        setReplyTo("");
        setOutcome({ kind: "queued" });
      } else {
        setOutcome({ kind: "error", message: feedbackSentence(data?.kind, data?.maxBody, MAX_FEEDBACK_BODY) });
      }
    } catch {
      // A dead network is not the endpoint refusing, and saying so is the difference between
      // "try again" and "there is nothing wrong with what you wrote".
      setOutcome({ kind: "error", message: OFFLINE_SENTENCE });
    } finally {
      setBusy(false);
    }
  }

  const remaining = MAX_FEEDBACK_BODY - body.length;
  // Only near the ceiling. A counter that is always on is noise for the 99% of messages nowhere
  // near 2,000 characters, and noise is what people stop reading.
  const showCount = remaining <= 200;

  return (
    <div className="fb" data-open={open ? "true" : "false"}>
      {open ? (
        <form className="fb-panel" id={panelId} onSubmit={submit} aria-label="Send feedback to the operator">
          <div className="fieldwrap">
            <label className="lbl" htmlFor={`${panelId}-body`}>
              What would you tell us?
            </label>
            <textarea
              id={`${panelId}-body`}
              ref={field}
              className="prompt fb-text"
              rows={4}
              maxLength={MAX_FEEDBACK_BODY}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What worked, what did not, what you expected"
            />
            {showCount ? (
              <p className="fine" aria-live="polite">
                {remaining} character{remaining === 1 ? "" : "s"} left
              </p>
            ) : null}
          </div>

          <div className="fieldwrap">
            <label className="lbl" htmlFor={`${panelId}-reply`}>
              How to reach you <span className="fine">(optional)</span>
            </label>
            <input
              id={`${panelId}-reply`}
              className="prompt"
              type="text"
              maxLength={MAX_FEEDBACK_REPLY_TO}
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="Only if you want an answer"
            />
          </div>

          {/* WHAT HAPPENS, WITHOUT NAMING WHERE IT GOES. The destination is box configuration and
              belongs in no tracked file, and a visitor does not need it to decide whether to
              write. What they DO need is that this is not instant and not anonymous-by-magic. */}
          <p className="fine">
            The faucet stores your message and hands it on separately, so it does not arrive
            instantly. Messages are kept for 30 days and then deleted.
          </p>

          <div className="actrow">
            <button type="submit" className="tag" disabled={busy || body.trim().length === 0}>
              {busy ? BUSY : "Send"}
            </button>
            <button
              type="button"
              className="tag"
              onClick={() => {
                setOpen(false);
                launcher.current?.focus();
              }}
            >
              Close
            </button>
          </div>

          {/* Polite, and OUTSIDE the branch that clears the form, so the confirmation is still
              announced after the box empties. */}
          <p className="fb-msg" role="status" aria-live="polite" data-tone={outcome.kind === "error" ? "bad" : outcome.kind === "queued" ? "ok" : undefined}>
            {outcome.kind === "queued"
              ? QUEUED_SENTENCE
              : outcome.kind === "error"
                ? outcome.message
                : ""}
          </p>
        </form>
      ) : null}

      <button
        type="button"
        ref={launcher}
        className="tag fb-launch"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        Feedback
      </button>
    </div>
  );
}
