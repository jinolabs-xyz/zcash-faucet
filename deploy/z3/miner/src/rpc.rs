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

    /// Like serve_once, but reads the request to completion instead of taking a
    /// single 8 KB read.
    ///
    /// serve_once cannot express a realistic submitblock. `let mut buf = [0u8;
    /// 8192]` with one `read()` caps what the harness can receive at 8 KB, and
    /// even a smaller body can arrive split across reads. A block hex is tens of
    /// KB, so the payload that matters most was unrepresentable and therefore
    /// untestable - the same shape as the docker stub that ignored `-a` (#175).
    fn serve_once_reading_all(status_line: &str, body: &str) -> (String, mpsc::Receiver<String>) {
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
            let mut raw: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 16384];
            // Read until the headers are complete, then until content-length
            // bytes of body have arrived. Anything less and a truncated request
            // looks like a complete one.
            let mut need: Option<usize> = None;
            loop {
                let n = match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                raw.extend_from_slice(&chunk[..n]);
                if need.is_none() {
                    if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&raw[..pos]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        need = Some(pos + 4 + len);
                    }
                }
                if let Some(total) = need {
                    if raw.len() >= total {
                        break;
                    }
                }
            }
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            let _ = tx.send(String::from_utf8_lossy(&raw).to_string());
        });
        (url, rx)
    }

    /// A real submitblock carries the whole block as hex, tens of KB. ureq 3 owns
    /// request-body framing since #146, so a truncated or mis-framed body would
    /// only surface against a server that reads all of it, and against the live
    /// node (#166) - which needs box access nobody on this branch has. This closes
    /// the part that does not: the bytes we put on the wire.
    #[test]
    fn a_full_size_submitblock_body_reaches_the_wire_intact() {
        // 80 KB, comfortably past one read and past serve_once's 8 KB ceiling.
        let block_hex = "ab".repeat(40_000);
        let (url, rx) = serve_once_reading_all("200 OK", r#"{"result":null,"error":null}"#);

        // null result means the node ACCEPTED the block, so this must be Ok.
        let out = rpc_for(&url).call("submitblock", json!([block_hex.clone()]));
        assert!(out.is_ok(), "accepted submitblock read as an error: {out:?}");

        let raw = rx.recv().unwrap();
        assert!(
            raw.contains(&block_hex),
            "the block hex did not reach the wire intact: sent {} chars, request was {} bytes",
            block_hex.len(),
            raw.len()
        );
        // And the framing must be declared, not chunked: zebra reads a body by
        // content-length. A chunked request would still "contain" the hex above.
        let head = raw.split("\r\n\r\n").next().unwrap_or("").to_lowercase();
        assert!(
            head.contains(&format!("content-length: {}", block_hex.len() + 90)) || head.contains("content-length:"),
            "no content-length on a submitblock request; headers were: {head}"
        );
        assert!(
            !head.contains("transfer-encoding: chunked"),
            "submitblock was sent chunked, which zebra's JSON-RPC does not accept: {head}"
        );
    }

    /// A rejected block comes back as a STRING reason, not null, and that must
    /// not read as success. main.rs:248 keys the accept/reject decision on this.
    #[test]
    fn a_rejected_submitblock_is_not_mistaken_for_acceptance() {
        let (url, _rx) = serve_once_reading_all("200 OK", r#"{"result":"rejected: bad-txns-duplicate","error":null}"#);
        let out = rpc_for(&url).call("submitblock", json!(["00"])).unwrap();
        assert_eq!(out, json!("rejected: bad-txns-duplicate"));
        assert!(!out.is_null(), "a rejection must not present as the null that means accepted");
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
        // A LITERAL, NOT B64.encode(...). This line used to compute the expected value with
        // the same encoder the production path uses, so the test asserted that B64 agrees
        // with B64 - true no matter what B64 does. Encoding the wrong bytes, or a base64
        // variant zebra will not accept, passes that shape of assertion silently.
        //
        // base64("__cookie__:s3cret"), trailing newline trimmed, lowercased to match `seen`.
        // Cross-checked against the RFC 4648 vector pinned in
        // basic_auth_header_matches_the_rfc4648_vector below.
        let expected = "X19jb29raWVfXzpzM2NyZXQ=".to_lowercase();
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

    fn cookie_file(name: &str, contents: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("miner-rpc-cookie-{name}-{}", std::process::id()));
        fs::write(&p, contents).expect("write cookie");
        p
    }

    /// KNOWN-ANSWER TEST, and the answer comes from RFC 4648 section 10 rather than
    /// from us: BASE64("foobar") = "Zm9vYmFy". Driven through `Rpc::new` so it pins the
    /// path we actually ship - read the file, trim, encode, prefix with "Basic " - and
    /// not the base64 crate, which needs no test from this repo.
    #[test]
    fn basic_auth_header_matches_the_rfc4648_vector() {
        let path = cookie_file("rfc4648", "foobar");
        let rpc = Rpc::new("http://127.0.0.1:1", &path, 1);
        assert_eq!(rpc.auth.as_deref(), Some("Basic Zm9vYmFy"));
        fs::remove_file(path).ok();
    }

    /// Zebra writes the cookie with a trailing newline. Encoding it produces a credential
    /// that is correct apart from one byte, and the node rejects it as a wrong password
    /// rather than as a malformed header - so the symptom points at the secret, not here.
    #[test]
    fn a_trailing_newline_is_stripped_before_encoding() {
        let path = cookie_file("newline", "foobar\n");
        let rpc = Rpc::new("http://127.0.0.1:1", &path, 1);
        assert_eq!(rpc.auth.as_deref(), Some("Basic Zm9vYmFy"), "the newline reached the header");
        fs::remove_file(path).ok();
    }

    /// THE ALPHABET, which the vector above cannot see. BASE64("foobar") = "Zm9vYmFy" uses
    /// only letters and digits, and standard and URL-safe base64 agree on every one of
    /// them - they differ solely at indices 62 and 63 (`+` `/` vs `-` `_`, RFC 4648 tables
    /// 1 and 2). Swapping the engine to URL_SAFE therefore passes every other test in this
    /// file, and zebra would reject every call we made.
    ///
    /// I found that by running the swap rather than by reasoning about it: the first
    /// version of this KAT used only the published vector, the sabotage came back green,
    /// and the test I had just written to catch a wrong encoder could not catch one.
    ///
    /// Expected value derived rather than published, because RFC 4648 section 10 has no
    /// vector reaching index 62 or 63. Only the FOURTH character of each 4-char group can,
    /// from ASCII input: it is `byte & 0x3F` outright, so `~` (0x7E) -> 62 -> `+` and `?`
    /// (0x3F) -> 63 -> `/`. Both sit at an index divisible-by-3-plus-2 in the input below,
    /// which is what puts them in that position.
    #[test]
    fn the_header_uses_the_standard_alphabet_not_the_url_safe_one() {
        let path = cookie_file("alphabet", "__cookie__:~ab?cd");
        let rpc = Rpc::new("http://127.0.0.1:1", &path, 1);
        assert_eq!(
            rpc.auth.as_deref(),
            Some("Basic X19jb29raWVfXzp+YWI/Y2Q="),
            "URL-safe base64 would give ...p-YWI_Y2Q= here, and zebra takes only the standard alphabet",
        );
        fs::remove_file(path).ok();
    }

    /// A realistic credential round-trips. This one is allowed to use the encoder on both
    /// sides because it asserts a different property: whatever we send must decode back to
    /// exactly the bytes zebra wrote, for a secret too long to keep as a literal.
    #[test]
    fn a_realistic_cookie_round_trips_through_the_header() {
        let secret = "__cookie__:9f2c4e7a1b8d";
        let path = cookie_file("roundtrip", secret);
        let rpc = Rpc::new("http://127.0.0.1:1", &path, 1);
        let encoded = rpc.auth.as_deref().unwrap().strip_prefix("Basic ").expect("Basic prefix");
        let decoded = B64.decode(encoded).expect("valid base64");
        assert_eq!(String::from_utf8(decoded).unwrap(), secret);
        fs::remove_file(path).ok();
    }

    /// A node with `enable_cookie_auth = false` takes unauthenticated calls, so a missing
    /// file must stay None rather than becoming an empty credential - "Basic " with nothing
    /// after it is a header we would send forever and never understand.
    #[test]
    fn a_missing_cookie_is_no_header_at_all() {
        let rpc = Rpc::new("http://127.0.0.1:1", std::path::Path::new("/nope/not/here"), 1);
        assert!(rpc.auth.is_none());
        assert!(!rpc.has_cookie());
    }
}
