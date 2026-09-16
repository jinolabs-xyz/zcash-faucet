/**
 * /limits: what the limits are and why, so the refusal cards do not have to explain
 * themselves.
 *
 * THE CARDS SAY WHEN, THIS PAGE SAYS WHY. A refusal card is read by someone who wanted a
 * drip and did not get one; the only thing they act on is when to come back, so that is
 * what the card carries. The reasoning is real and worth publishing, but it belongs
 * somewhere a reader chooses to go.
 *
 * EVERY NUMBER IS READ FROM CONFIG, never typed. A limits page that drifts from what the
 * server enforces is worse than none: it turns a refusal a visitor could have predicted
 * into one that looks arbitrary.
 */
import { config } from "@/lib/config";
import { dripsNow } from "@/lib/db";
import { Shell, CHECKING_BADGE } from "@/components/Shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Limits · Zcash Testnet Faucet",
  description: "How this faucet rate limits, and what to do when it refuses.",
};

const hours = (s: number) => Math.round(s / 3600);

export default async function Limits() {
  const drips = await dripsNow();
  const { cooldownSeconds, ipDailyMax, subnetDailyMax, dripTaz, challenge } = config;
  const capTaz = Number(config.dailyCapZatoshi) / 100_000_000;
  const window = hours(cooldownSeconds);

  return (
    <Shell nav={{ kind: "links" }} badge={CHECKING_BADGE} status={{ maintenanceAddress: config.maintenanceAddress.trim(), drips }}>
      <section className="view hero sub" aria-label="Limits">
        <div className="hero-copy" style={{ width: "100%" }}>
          <p className="eyebrow mono">Zcash testnet faucet</p>
          <h1>Limits.</h1>
          <p className="lede">Testnet coins are free but not unlimited. These keep the tap open for everyone.</p>
        </div>

        <div className="terms">
          <div>
            <h2>What they are</h2>
            <dl className="receipt">
              <dt>Per address</dt><dd>one drip of {dripTaz} TAZ every {window} h</dd>
              <dt>Per connection</dt><dd>{ipDailyMax} drips every {window} h</dd>
              <dt>Per network</dt><dd>{subnetDailyMax} drips every {window} h, shared</dd>
              <dt>Whole faucet</dt><dd>{capTaz} TAZ in any rolling {window} h</dd>
            </dl>
          </div>

          <div>
            <h2>Why a different address does not help</h2>
            {/* THE ONE QUESTION EVERY REFUSED VISITOR ASKS, and the honest answer is that
                the limit is not on the address. Saying so here means the card can say it
                in six words instead of three sentences. */}
            <p>
              The connection and network limits count requests, not addresses. Generating a new
              address does not reset them, which is the point: without that, one person could
              drain the faucet in a loop.
            </p>
            <p>
              The per-address limit is separate. An address that has just been paid waits its
              {" "}{window} h whatever connection asks for it.
            </p>
          </div>

          <div>
            <h2>The rolling window</h2>
            {/* MEASURED, NOT ASSUMED: sql.ts uses `now - 86_400`, so it is a rolling window
                rather than a reset at midnight. A visitor told "resets at midnight" comes
                back at 00:01 to the same refusal, which is #596's family of defect. */}
            <p>
              Nothing resets at midnight. Each limit looks back over the last {window} h, so a
              slot frees up {window} h after the request that used it, not at a fixed hour.
            </p>
          </div>

          {challenge === "pow" ? (
            <div>
              <h2>The puzzle</h2>
              <p>
                Before a drip the browser solves a short proof of work. It runs on its own and
                needs no interaction. It is there so the limits above cost something to probe.
              </p>
            </div>
          ) : null}

          <div>
            <h2>If you think a limit is wrong</h2>
            <p>
              Quote the request id shown on the refusal card and <a href="/terms">write to us</a>.
              It identifies the request without identifying you.
            </p>
          </div>
        </div>
      </section>
    </Shell>
  );
}
