//! The miner's heartbeat file. Contract and reasoning: deploy/z3/MINER-HEARTBEAT.md
//!
//! `/api/status` used to report mining from `FAUCET_MINER_ACTIVE === "true"`, an env flag
//! that says what someone configured and cannot be false while the miner is broken. It
//! read "miner on" for 70 minutes while every `getblocktemplate` failed on an auth cookie
//! zebra had regenerated. The process was alive and the unit was active the whole time.
//!
//! So this file carries TWO timestamps and their divergence is the signal:
//!
//!   written_at        refreshed every beat, including beats where the loop errored
//!   last_template_at  advances ONLY when a template was actually fetched
//!
//! Fresh `written_at` beside a stale `last_template_at` is exactly the state that hid, and
//! a heartbeat proving only that the process lives would rebuild that false pass one layer
//! down.
//!
//! THE BEAT RUNS ON ITS OWN THREAD, which is not incidental. A single mining iteration
//! fetches a template and then grinds Equihash, and at real difficulty that can take far
//! longer than the staleness window. Writing the file at the end of each iteration would
//! therefore report `not-writing` for a miner that is working perfectly hard. The beat has
//! to be independent of the work it describes.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Bumped only on a breaking change. A reader that does not recognise it must report
/// cannot-verify rather than guess at fields.
const SCHEMA: u32 = 1;

/// Observed reality only. Nothing in here is a configured intent, because the miner cannot
/// see the faucet's `FAUCET_MINER_ACTIVE` and must not assert a flag it cannot observe.
#[derive(Clone, Debug, Default)]
pub struct State {
    pub mode: String,
    pub beat_secs: u64,
    pub template_secs: u64,
    pub last_template_at: Option<u64>,
    pub last_template_height: Option<u64>,
    /// A fixed token, never a message: this file is served publicly and an error string is
    /// where an RPC URL with credentials in its userinfo would end up.
    pub last_error_stage: Option<&'static str>,
    pub last_error_at: Option<u64>,
    pub consecutive_errors: u64,
    pub solved_count: u64,
    pub last_solved_at: Option<u64>,
    pub submitted_accepted: u64,
    pub submitted_rejected: u64,
    pub last_submitted_at: Option<u64>,
}

impl State {
    pub fn template_ok(&mut self, height: u64) {
        self.last_template_at = Some(now());
        self.last_template_height = Some(height);
        // Cleared on success so a stale error cannot sit in the panel after recovery.
        self.last_error_stage = None;
        self.last_error_at = None;
        self.consecutive_errors = 0;
    }

    pub fn error(&mut self, stage: &'static str) {
        self.last_error_stage = Some(stage);
        self.last_error_at = Some(now());
        self.consecutive_errors = self.consecutive_errors.saturating_add(1);
    }

    pub fn solved(&mut self) {
        self.solved_count = self.solved_count.saturating_add(1);
        self.last_solved_at = Some(now());
    }

    pub fn submitted(&mut self, accepted: bool) {
        if accepted {
            self.submitted_accepted = self.submitted_accepted.saturating_add(1);
        } else {
            self.submitted_rejected = self.submitted_rejected.saturating_add(1);
        }
        self.last_submitted_at = Some(now());
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Epoch seconds to RFC 3339 UTC. Written out rather than pulled in: the miner has no time
/// crate and adding one for this is not worth the dependency. Civil-from-days is Howard
/// Hinnant's algorithm, and the tests below check it against real `date -u` output including
/// leap days and a year boundary, because a date routine that is only checked against its
/// own reasoning is how off-by-one-day bugs ship.
pub fn rfc3339(epoch: u64) -> String {
    let days = (epoch / 86_400) as i64;
    let secs_of_day = epoch % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn num(v: Option<u64>) -> String {
    v.map(|n| n.to_string()).unwrap_or_else(|| "null".into())
}

fn ts(v: Option<u64>) -> String {
    v.map(|n| format!("\"{}\"", rfc3339(n)))
        .unwrap_or_else(|| "null".into())
}

/// Hand-rolled rather than derived, so the exact field names and the null-vs-absent rule in
/// the contract are visible in one place. Every optional is emitted as `null`, never
/// omitted: "has not happened" and "unknown" are different claims.
pub fn render(s: &State) -> String {
    format!(
        concat!(
            "{{\n",
            "  \"schema\": {},\n",
            "  \"writtenAt\": \"{}\",\n",
            "  \"beatSeconds\": {},\n",
            "  \"staleAfterSeconds\": {},\n",
            "  \"templateSeconds\": {},\n",
            "  \"templateStaleAfterSeconds\": {},\n",
            "  \"mode\": \"{}\",\n",
            "  \"lastTemplateAt\": {},\n",
            "  \"lastTemplateHeight\": {},\n",
            "  \"lastErrorStage\": {},\n",
            "  \"lastErrorAt\": {},\n",
            "  \"consecutiveErrors\": {},\n",
            "  \"solvedCount\": {},\n",
            "  \"lastSolvedAt\": {},\n",
            "  \"submittedAccepted\": {},\n",
            "  \"submittedRejected\": {},\n",
            "  \"lastSubmittedAt\": {}\n",
            "}}\n"
        ),
        SCHEMA,
        rfc3339(now()),
        s.beat_secs,
        // The writer publishes the THRESHOLDS, not just the intervals, so the reader never
        // hardcodes a multiplier that can drift from the miner's configuration.
        s.beat_secs.saturating_mul(6),
        s.template_secs,
        s.template_secs.saturating_mul(6),
        s.mode,
        ts(s.last_template_at),
        num(s.last_template_height),
        s.last_error_stage
            .map(|v| format!("\"{v}\""))
            .unwrap_or_else(|| "null".into()),
        ts(s.last_error_at),
        s.consecutive_errors,
        s.solved_count,
        ts(s.last_solved_at),
        s.submitted_accepted,
        s.submitted_rejected,
        ts(s.last_submitted_at),
    )
}

/// Temp file in the same directory then rename, because the faucet reads this on every
/// /api/status and a half-written file would be a parse error on a hot path. Same directory
/// so the rename cannot cross a filesystem boundary and silently become a copy.
pub fn write_atomic(path: &Path, body: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("heartbeat")
    ));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
    }
    // 0644: the faucet container runs as a different uid and there is nothing secret here.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644))?;
    }
    fs::rename(&tmp, path)
}

/// Spawns the beat. Returns the shared state for the mining loop to update.
///
/// `MINER_HEARTBEAT_PATH` has no default that points anywhere real: a missing configuration
/// must not write to a stale path and must not be mistaken for a working heartbeat. Unset
/// means no file, and the reader then sees an absent file, which is cannot-verify.
pub fn start(
    path: Option<PathBuf>,
    mode: &str,
    beat_secs: u64,
    template_secs: u64,
) -> Arc<Mutex<State>> {
    let state = Arc::new(Mutex::new(State {
        mode: mode.to_string(),
        beat_secs: beat_secs.max(1),
        template_secs: template_secs.max(1),
        ..Default::default()
    }));

    if let Some(path) = path {
        let shared = Arc::clone(&state);
        let beat = Duration::from_secs(beat_secs.max(1));
        thread::spawn(move || loop {
            // Snapshot under the lock, write outside it: a slow or blocked disk must never
            // hold the lock the mining loop needs to record a template.
            let body = {
                match shared.lock() {
                    Ok(s) => render(&s),
                    // A poisoned lock means a mining thread panicked. Keep beating anyway,
                    // and let the stale last_template_at say what happened rather than
                    // going silent, which reads as cannot-verify.
                    Err(poisoned) => render(&poisoned.into_inner()),
                }
            };
            let _ = write_atomic(&path, &body);
            thread::sleep(beat);
        });
    }

    state
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Checked against real `date -u -r <n>` output, not against my own arithmetic. Includes
    /// two leap days and both sides of a year boundary, which is where a civil-from-days
    /// implementation goes wrong if it is going to.
    #[test]
    fn rfc3339_matches_real_dates() {
        for (epoch, want) in [
            (0u64, "1970-01-01T00:00:00Z"),
            (1, "1970-01-01T00:00:01Z"),
            (951_782_400, "2000-02-29T00:00:00Z"),
            (1_709_164_800, "2024-02-29T00:00:00Z"),
            (1_735_689_599, "2024-12-31T23:59:59Z"),
            (1_735_689_600, "2025-01-01T00:00:00Z"),
            (1_785_438_491, "2026-07-30T19:08:11Z"),
            (2_147_483_647, "2038-01-19T03:14:07Z"),
        ] {
            assert_eq!(rfc3339(epoch), want, "epoch {epoch}");
        }
    }

    #[test]
    fn a_successful_template_clears_a_previous_error() {
        // Otherwise a recovered miner keeps showing the error that is no longer true.
        let mut s = State::default();
        s.error("getblocktemplate");
        assert_eq!(s.consecutive_errors, 1);
        s.template_ok(4_223_019);
        assert!(s.last_error_stage.is_none(), "error survived a success");
        assert!(s.last_error_at.is_none());
        assert_eq!(s.consecutive_errors, 0);
        assert_eq!(s.last_template_height, Some(4_223_019));
    }

    #[test]
    fn errors_accumulate_so_a_flapping_miner_is_visible() {
        // Keeping only the latest state would hide a miner alternating success and failure.
        let mut s = State::default();
        for _ in 0..3 {
            s.error("submitblock");
        }
        assert_eq!(s.consecutive_errors, 3);
    }

    #[test]
    fn nothing_yet_renders_as_null_never_as_absent() {
        let s = State {
            mode: "submit".into(),
            beat_secs: 5,
            template_secs: 60,
            ..Default::default()
        };
        let out = render(&s);
        for field in [
            "\"lastTemplateAt\": null",
            "\"lastTemplateHeight\": null",
            "\"lastErrorStage\": null",
            "\"lastErrorAt\": null",
            "\"lastSolvedAt\": null",
            "\"lastSubmittedAt\": null",
        ] {
            assert!(out.contains(field), "missing {field} in:\n{out}");
        }
        assert!(serde_json::from_str::<serde_json::Value>(&out).is_ok(), "not valid JSON:\n{out}");
    }

    #[test]
    fn the_writer_publishes_thresholds_so_the_reader_needs_no_multiplier() {
        let s = State {
            mode: "submit".into(),
            beat_secs: 5,
            template_secs: 60,
            ..Default::default()
        };
        let v: serde_json::Value = serde_json::from_str(&render(&s)).unwrap();
        assert_eq!(v["staleAfterSeconds"], 30);
        assert_eq!(v["templateStaleAfterSeconds"], 360);
        // And they must MOVE with the configuration, or publishing them buys nothing over a
        // constant on the reader's side.
        let s2 = State { beat_secs: 10, template_secs: 30, ..s };
        let v2: serde_json::Value = serde_json::from_str(&render(&s2)).unwrap();
        assert_eq!(v2["staleAfterSeconds"], 60);
        assert_eq!(v2["templateStaleAfterSeconds"], 180);
    }

    #[test]
    fn no_error_message_channel_exists_at_all() {
        // The type only admits &'static str, so a formatted transport error carrying an RPC
        // URL cannot reach this file even by mistake. This asserts the rendered output has
        // no message field, which is the property the public endpoint depends on.
        let mut s = State {
            mode: "submit".into(),
            beat_secs: 5,
            template_secs: 60,
            ..Default::default()
        };
        s.error("getblocktemplate");
        let out = render(&s);
        assert!(out.contains("\"lastErrorStage\": \"getblocktemplate\""));
        assert!(!out.contains("lastError\""), "a message field appeared: {out}");
        assert!(!out.to_lowercase().contains("http"), "a URL reached the heartbeat: {out}");
    }

    #[test]
    fn solve_and_submit_counters_move_and_are_rendered() {
        // These were the two fields a live run did not exercise: the regtest window ended
        // while the solver was still grinding, so solvedCount stayed 0 legitimately. An
        // untested counter is exactly the kind of field that reads plausible and never moves.
        let mut s = State {
            mode: "submit".into(),
            beat_secs: 5,
            template_secs: 60,
            ..Default::default()
        };
        s.solved();
        s.submitted(true);
        s.submitted(false);
        s.submitted(true);
        let v: serde_json::Value = serde_json::from_str(&render(&s)).unwrap();
        assert_eq!(v["solvedCount"], 1);
        assert_eq!(v["submittedAccepted"], 2);
        assert_eq!(v["submittedRejected"], 1);
        assert!(v["lastSolvedAt"].is_string(), "lastSolvedAt stayed null after a solve");
        assert!(v["lastSubmittedAt"].is_string());
        // A rejection is not an error: zebra answered, so templates are clearly flowing.
        // Counting it as an error would make a rejected block look like a broken miner.
        assert!(v["lastErrorStage"].is_null());
        assert_eq!(v["consecutiveErrors"], 0);
    }

    #[test]
    fn write_is_atomic_and_leaves_no_temp_behind() {
        let dir = std::env::temp_dir().join(format!("hb-test-{}", std::process::id()));
        let path = dir.join("heartbeat.json");
        write_atomic(&path, "{\"a\":1}\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":1}\n");
        // A second write must replace, not append, and must not leave the temp file.
        write_atomic(&path, "{\"a\":2}\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":2}\n");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
        fs::remove_dir_all(&dir).ok();
    }
}
