//! Minimal JSON-RPC client for zebra, with cookie auth.

use std::{fs, path::Path, time::Duration};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};

pub struct Rpc {
    url: String,
    auth: Option<String>,
    agent: ureq::Agent,
}

impl Rpc {
    /// Reads the cookie file zebra writes (`__cookie__:<password>`) and builds
    /// a Basic auth header from it. A missing cookie is not fatal: a node with
    /// `enable_cookie_auth = false` takes unauthenticated calls.
    pub fn new(url: &str, cookie_path: &Path, timeout_secs: u64) -> Self {
        let auth = fs::read_to_string(cookie_path).ok().map(|contents| {
            format!("Basic {}", B64.encode(contents.trim().as_bytes()))
        });
        // http_status_as_error(false) is load bearing. By default ureq turns a
        // non-2xx into an error that carries the status and NOT the body, and
        // for a 401 the body is the part that tells you which cookie it wanted.
        // Keeping statuses as ordinary responses is what lets call() read both.
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(timeout_secs)))
            .http_status_as_error(false)
            .build();
        Self {
            url: url.to_string(),
            auth,
            agent: config.into(),
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

        let mut req = self
            .agent
            .post(&self.url)
            .header("content-type", "application/json");
        if let Some(auth) = &self.auth {
            req = req.header("authorization", auth);
        }

        // A JSON-RPC error comes back as HTTP 200 with an error member, but
        // auth failures and the like are real HTTP statuses with a body worth
        // showing, so read both rather than just reporting the status.
        let mut response = req
            .send_json(&body)
            .map_err(|e| format!("{method}: {e}"))?;

        let status = response.status();
        if !status.is_success() {
            let text = response.body_mut().read_to_string().unwrap_or_default();
            return Err(format!(
                "{method}: HTTP {}: {}",
                status.as_u16(),
                text.trim()
            ));
        }

        let parsed: Value = response
            .body_mut()
            .read_json()
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    /// Answers exactly one request from loopback and hands back the raw request
    /// bytes it saw, so a test can assert on what we actually put on the wire.
    fn serve_once(status_line: &str, body: &str) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let response = format!(
            "HTTP/1.1 {status_line}\r\ncontent-type: application/json\r\n\
             content-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
        });
        (url, rx)
    }

    fn rpc_for(url: &str) -> Rpc {
        Rpc::new(url, Path::new("/nonexistent/cookie"), 5)
    }

    // The reason http_status_as_error(false) is set. ureq 3's default turns a
    // non-2xx into an error carrying the status and NOT the body, and for a 401
    // the body names which cookie the node wanted. If a later bump flips that
    // default back, this test is what notices.
    #[test]
    fn an_http_error_keeps_the_body_not_just_the_status() {
        let (url, _rx) = serve_once("401 Unauthorized", "cookie authentication failed");
        let err = rpc_for(&url)
            .call("getblockcount", json!([]))
            .expect_err("a 401 must not be reported as success");
        assert!(err.contains("HTTP 401"), "status is missing from: {err}");
        assert!(
            err.contains("cookie authentication failed"),
            "the body is what says which cookie it wanted, and it is missing from: {err}"
        );
    }

    // A JSON-RPC error rides on HTTP 200, so status alone would call this a win.
    #[test]
    fn a_json_rpc_error_on_http_200_is_still_an_error() {
        let (url, _rx) = serve_once(
            "200 OK",
            r#"{"jsonrpc":"2.0","id":"x","result":null,"error":{"code":-8,"message":"block not found"}}"#,
        );
        let err = rpc_for(&url)
            .call("getblock", json!(["deadbeef"]))
            .expect_err("an error member must not be read as success");
        assert!(err.contains("block not found"), "got: {err}");
    }

    #[test]
    fn a_result_comes_back_unwrapped() {
        let (url, _rx) = serve_once("200 OK", r#"{"jsonrpc":"2.0","id":"x","result":4200000}"#);
        let got = rpc_for(&url).call("getblockcount", json!([])).unwrap();
        assert_eq!(got, json!(4200000));
    }

    // A 200 with neither result nor error is a node we do not understand, and
    // silently returning null would send a mined block against nothing.
    #[test]
    fn a_response_with_no_result_is_an_error() {
        let (url, _rx) = serve_once("200 OK", r#"{"jsonrpc":"2.0","id":"x"}"#);
        let err = rpc_for(&url)
            .call("getblockcount", json!([]))
            .expect_err("a missing result must not read as null");
        assert!(err.contains("no result"), "got: {err}");
    }

    #[test]
    fn html_from_a_wrong_port_says_it_was_not_json() {
        let (url, _rx) = serve_once("200 OK", "<html>not a node</html>");
        let err = rpc_for(&url)
            .call("getblockcount", json!([]))
            .expect_err("html must not parse as a result");
        assert!(err.contains("not JSON"), "got: {err}");
    }

    // The header rename from set() to header() is the kind of migration that
    // compiles whether or not the header is still sent, so assert on the wire.
    #[test]
    fn the_cookie_becomes_a_basic_auth_header_on_the_wire() {
        let dir = std::env::temp_dir().join(format!("miner-rpc-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let cookie = dir.join(".cookie");
        fs::write(&cookie, "__cookie__:s3cret\n").unwrap();

        let (url, rx) = serve_once("200 OK", r#"{"result":1}"#);
        let rpc = Rpc::new(&url, &cookie, 5);
        assert!(rpc.has_cookie(), "the cookie file was readable, so auth is expected");
        let _ = rpc.call("getblockcount", json!([]));

        let seen = rx.recv().unwrap().to_lowercase();
        // base64("__cookie__:s3cret"), trimmed of the trailing newline.
        let expected = B64.encode("__cookie__:s3cret".as_bytes()).to_lowercase();
        assert!(
            seen.contains(&format!("authorization: basic {expected}")),
            "no basic auth header on the wire, request was:\n{seen}"
        );
        assert!(
            seen.contains("content-type: application/json"),
            "content-type went missing, request was:\n{seen}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_cookie_file_means_no_auth_header() {
        let (url, rx) = serve_once("200 OK", r#"{"result":1}"#);
        let rpc = rpc_for(&url);
        assert!(!rpc.has_cookie());
        let _ = rpc.call("getblockcount", json!([]));
        let seen = rx.recv().unwrap().to_lowercase();
        assert!(!seen.contains("authorization:"), "unexpected auth header:\n{seen}");
    }
}
