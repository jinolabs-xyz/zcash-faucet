//! Minimal JSON-RPC client for zebra, with cookie auth.

use std::{fs, path::Path, time::Duration};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};

pub struct Rpc {
    url: String,
    auth: Option<String>,
    timeout: Duration,
}

impl Rpc {
    /// Reads the cookie file zebra writes (`__cookie__:<password>`) and builds
    /// a Basic auth header from it. A missing cookie is not fatal: a node with
    /// `enable_cookie_auth = false` takes unauthenticated calls.
    pub fn new(url: &str, cookie_path: &Path, timeout_secs: u64) -> Self {
        let auth = fs::read_to_string(cookie_path).ok().map(|contents| {
            format!("Basic {}", B64.encode(contents.trim().as_bytes()))
        });
        Self {
            url: url.to_string(),
            auth,
            timeout: Duration::from_secs(timeout_secs),
        }
    }

    pub fn has_cookie(&self) -> bool {
        self.auth.is_some()
    }

    /// One JSON-RPC call. Returns the `result` field, or the error text.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": "zcash-testnet-miner",
            "method": method,
            "params": params,
        });

        let mut req = ureq::post(&self.url)
            .timeout(self.timeout)
            .set("content-type", "application/json");
        if let Some(auth) = &self.auth {
            req = req.set("authorization", auth);
        }

        // A JSON-RPC error comes back as HTTP 200 with an error member, but
        // auth failures and the like are real HTTP statuses with a body worth
        // showing, so read both rather than just reporting the status.
        let response = match req.send_json(body) {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) => {
                let text = r.into_string().unwrap_or_default();
                return Err(format!("{method}: HTTP {code}: {}", text.trim()));
            }
            Err(e) => return Err(format!("{method}: {e}")),
        };

        let parsed: Value = response
            .into_json()
            .map_err(|e| format!("{method}: response was not JSON: {e}"))?;
        if let Some(err) = parsed.get("error") {
            if !err.is_null() {
                return Err(format!("{method}: {err}"));
            }
        }
        parsed
            .get("result")
            .cloned()
            .ok_or_else(|| format!("{method}: response had no result"))
    }
}
