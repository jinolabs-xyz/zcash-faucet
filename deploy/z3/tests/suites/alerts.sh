# shellcheck shell=bash
# alert.sh: the shared sender used by watchdog.sh and every OnFailure hook.
# A real HTTP receiver records what arrives, so the body shape is checked
# rather than assumed.

ALERT="$REPO/deploy/z3/alert.sh"

alerts_env() {
  mk_scratch "${TMPDIR:-/tmp}/alerts-test.XXXXXX"
  export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
  mkdir -p "$T/bin"
  export PATH="$T/bin:$BASE_PATH"
  export FAUCET_ALERT_URL="http://127.0.0.1:$HOOK_PORT/hook"
  export FAUCET_ALERT_FORMAT=slack
  # A fresh cooldown state per test, so one test's sends cannot hold back another's.
  export FAUCET_ALERT_STATE_DIR="$T/alert-state"
  unset WATCHDOG_ALERT_URL WATCHDOG_ALERT_FORMAT FAUCET_ALERT_PREFIX \
        FAUCET_ALERT_SIGNAL_NUMBER FAUCET_ALERT_SIGNAL_RECIPIENT FAUCET_ALERT_COOLDOWN_SECONDS 2>/dev/null
  : > "$HOOK_LOG"
}

HOOK_PORT="${ALERT_TEST_PORT:-18921}"
HOOK_LOG="${TMPDIR:-/tmp}/alert-hook.log"
python3 - "$HOOK_PORT" "$HOOK_LOG" <<'PY' >/dev/null 2>&1 &
import http.server,sys
port,logf=int(sys.argv[1]),sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length',0)); body=self.rfile.read(n).decode()
        # /slow answers after 1.2 s: a bridge is not a zero-latency receiver, and the
        # cooldown's concurrency case needs a POST long enough for the clock to move.
        if '/slow' in self.path:
            import time; time.sleep(1.2)
        open(logf,'a').write(body+"\n")
        code=500 if 'FAIL' in self.path else 204
        self.send_response(code); self.end_headers()
    def log_message(self,*a): pass
# Threaded, so parallel POSTs are served in parallel: with a single-threaded receiver the
# "distinct causes do not queue" case would measure the receiver's queue, not ours.
http.server.ThreadingHTTPServer(("127.0.0.1",port),H).serve_forever()
PY
HOOK_PID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null -X POST -d '{}' "http://127.0.0.1:$HOOK_PORT/warmup" && break; sleep 0.25; done
: > "$HOOK_LOG"

echo "== alerts: a plain message reaches the webhook in slack shape"
alerts_env
bash "$ALERT" "disk is nearly full" > "$T/plain.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "webhook received it" "grep -q 'disk is nearly full' '$HOOK_LOG'"
check "slack key used" "grep -q '\"text\"' '$HOOK_LOG'"
check "prefixed so the channel shows the source" "grep -q 'zcash-faucet' '$HOOK_LOG'"

echo "== alerts: discord gets the other key, because each rejects the other's"
alerts_env; export FAUCET_ALERT_FORMAT=discord
bash "$ALERT" "hello" > /dev/null 2>&1
check "discord key used" "grep -q '\"content\"' '$HOOK_LOG'"
check "no slack key" "! grep -q '\"text\"' '$HOOK_LOG'"

# Signal has no webhook. The way in is signal-cli-rest-api, a bridge on the box that
# links to your own account as a secondary device; its /v2/send wants message, the
# sending number, and a recipients list. Sending to your own number lands in Note to
# Self, which is the default here so one variable is enough.
echo "== alerts: signal posts the signal-cli-rest-api shape, to yourself by default"
alerts_env; export FAUCET_ALERT_FORMAT=signal FAUCET_ALERT_SIGNAL_NUMBER=+15551234567
bash "$ALERT" "node is behind" > "$T/sig.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "message key used" "grep -q '\"message\"' '$HOOK_LOG'"
check "sent from the linked number" "grep -q '\"number\":\"+15551234567\"' '$HOOK_LOG'"
check "and to it, so it lands in Note to Self" "grep -q '\"recipients\":\\[\"+15551234567\"\\]' '$HOOK_LOG'"
check "no slack or discord key" "! grep -qE '\"text\"|\"content\"' '$HOOK_LOG'"

echo "== alerts: signal with a separate recipient sends there instead"
alerts_env; export FAUCET_ALERT_FORMAT=signal FAUCET_ALERT_SIGNAL_NUMBER=+15551234567 FAUCET_ALERT_SIGNAL_RECIPIENT=+15559876543
bash "$ALERT" "hello" > /dev/null 2>&1
check "recipient is the other number" "grep -q '\"recipients\":\\[\"+15559876543\"\\]' '$HOOK_LOG'"

echo "== alerts: signal without a number is NOT SENT, loudly, rather than a malformed post"
alerts_env; export FAUCET_ALERT_FORMAT=signal; unset FAUCET_ALERT_SIGNAL_NUMBER FAUCET_ALERT_SIGNAL_RECIPIENT
bash "$ALERT" "nobody will hear this" > "$T/signone.log" 2>&1
check "exits 3, the not-configured code" "[ $? -eq 3 ]"
check "says NOT SENT and names the variable to set" "grep -q 'NOT SENT.*FAUCET_ALERT_SIGNAL_NUMBER' '$T/signone.log'"
check "nothing reached the bridge" "! grep -q 'nobody will hear' '$HOOK_LOG'"

echo "== alerts: a signal number that is not E.164 is refused before anything is sent"
alerts_env; export FAUCET_ALERT_FORMAT=signal FAUCET_ALERT_SIGNAL_NUMBER=5551234567
bash "$ALERT" "bad number" > "$T/sigbad.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "and says what shape it wanted" "grep -q 'E.164' '$T/sigbad.log'"
check "nothing reached the bridge" "! grep -q 'bad number' '$HOOK_LOG'"

echo "== alerts: an unknown format still sends, and says so"
alerts_env; export FAUCET_ALERT_FORMAT=telegram
bash "$ALERT" "hello" > "$T/unk.log" 2>&1
check "still sent" "grep -q hello '$HOOK_LOG'"
check "warns about the unknown format" "grep -q 'unknown FAUCET_ALERT_FORMAT' '$T/unk.log'"

echo "== alerts: quotes and newlines in the message cannot break the JSON"
alerts_env
bash "$ALERT" 'container "faucet-web" died
second line' > /dev/null 2>&1
check "webhook got valid JSON" "python3 -c \"import json,sys;[json.loads(l) for l in open('$HOOK_LOG') if l.strip()]\""
check "the quoted name survived" "grep -q 'faucet-web' '$HOOK_LOG'"

echo "== alerts: unconfigured is loud locally and exits 3, never silent"
alerts_env; unset FAUCET_ALERT_URL
bash "$ALERT" "nobody will hear this" > "$T/noconf.log" 2>&1
check "exits 3" "[ $? -eq 3 ]"
check "says NOT SENT with the reason" "grep -q 'NOT SENT (no FAUCET_ALERT_URL' '$T/noconf.log'"
check "nothing reached the webhook" "! grep -q 'nobody will hear' '$HOOK_LOG'"

echo "== alerts: self-test uses the real send path and reports honestly"
alerts_env
bash "$ALERT" --self-test > "$T/st.log" 2>&1
check "passes when configured" "[ $? -eq 0 ] && grep -q 'SELF-TEST PASSED' '$T/st.log'"
check "the channel actually received it" "grep -q 'self-test from' '$HOOK_LOG'"
alerts_env; unset FAUCET_ALERT_URL
bash "$ALERT" --self-test > "$T/st2.log" 2>&1
check "fails when unconfigured" "[ $? -ne 0 ] && grep -q 'SELF-TEST FAILED' '$T/st2.log'"
check "and names the file to edit" "grep -q '/etc/faucet/alerts.env' '$T/st2.log'"
alerts_env; export FAUCET_ALERT_URL="http://127.0.0.1:$HOOK_PORT/FAIL"
bash "$ALERT" --self-test > "$T/st3.log" 2>&1
check "fails when the webhook rejects" "[ $? -ne 0 ] && grep -q 'webhook rejected' '$T/st3.log'"

echo "== alerts: the OnFailure hook names the unit and quotes its logs"
alerts_env
printf '#!/usr/bin/env bash\necho "boom: something exploded"\n' > "$T/bin/journalctl"
chmod +x "$T/bin/journalctl"
bash "$ALERT" --unit zsnap-export.service > /dev/null 2>&1
check "names the failing unit" "grep -q 'unit FAILED: zsnap-export.service' '$HOOK_LOG'"
check "includes the journal tail, so no SSH needed to triage" "grep -q 'something exploded' '$HOOK_LOG'"

echo "== alerts: everything an alert carries is REDACTED before it leaves the box (risk register #22)"
# The tail is whatever the failing unit chose to print, and it travels to a third-party
# webhook or a Signal bridge and stays in that chat history. Review of the first version
# found three classes of leak (curl -u, JSON bodies, Zcash spending keys) and one class of
# over-redaction that destroyed this repo's own log lines. Both directions are pinned.
alerts_env
# Stage 1 matches the box's own secrets BY VALUE. The fixture stands in for
# /etc/faucet/alerts.env and the app's faucet.env.
cat > "$T/secrets.env" <<'E'
ZALLET_RPC_PASSWORD=hunter2isalongpassword
RATE_LIMIT_SALT=9f3c1de4b7a25086f2e1
# A value full of regex metacharacters. Stage 1 turns each value into a pattern, so an
# unescaped one matches the wrong text or breaks the filter, and a broken filter
# withholds every page. Nothing held this before.
BACKUP_TOKEN=a.b*c[d]e+f(g)
# A SELECTED name with a short value. The first fixture used a name the include list does
# not match, so the length guard could be deleted and the check still passed - one step
# earlier than it claimed.
SPARE_TOKEN=short
# Selected by the OLD broad list (*COOKIE*), not by the narrow one, and the value is
# neither a path nor a URL: this is what makes narrowing the list load-bearing.
ZEBRA_RPC_COOKIE_NAME=__cookie__value1
# Selected by the NARROW list (*TOKEN*) with a value that is a plain URL: this is what
# makes the URL skip load-bearing.
METRICS_TOKEN_ENDPOINT=https://metrics.example.org/push
# Selected by the narrow list (*SEED*) and excluded by *PUBLIC*.
PUBLIC_SEED_NODES=seed1.example.org,seed2.example.org
# PUBLIC configuration that only LOOKS secret-ish. Stage 1 blanks a value wherever it
# appears, so selecting these by name erases the address a page is about.
WATCHDOG_FAUCET_URL=https://faucet.example.org
HOSH_URL=https://hosh.zec.rocks
NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x4AAAAAAApublicsitekey
BACKUP_IDENTITY_FILE=identity.txt
ZEBRA_COOKIE_FILE=/run/zebra/.cookie
E
# A SECOND FILE, because the box keeps its secrets in six of them and BACKUP_PASSPHRASE
# lives in backup.env. Putting it in the one file alert.sh already read was a false pass.
cat > "$T/backup.env" <<'E'
BACKUP_PASSPHRASE=correct horse battery staple
# BACKUPS.md tells the operator to generate this with `openssl rand -base64 30`, and
# base64's alphabet contains `/`, so about one in 64 begins with one. A "value that looks
# like a path" skip dropped exactly those, in silence.
ZSNAP_RESTORE_PASSPHRASE=/kQ9zZ1YnHhw2qk3l4mN5oP6qR7sT8uV9wX0yZ1a
E
export FAUCET_ALERT_SECRET_FILES="$T/secrets.env
$T/backup.env"
cat > "$T/bin/journalctl" <<'J'
#!/usr/bin/env bash
echo "zallet: connecting to http://rpcuser:hunter2@127.0.0.1:8232"
echo "rpcpassword=s3cr3tvalue"
# THE SPELLINGS THIS BOX USES. Every one of these walked through the first name rule,
# which required the keyword to stand alone and so only ever matched the bare form the
# fixture happened to use.
echo "PGPASSWORD=pgsecretvalue123"
echo "ZALLET_RPC_PASSWORD=notinanyfile2"
echo "WALLET_PASSPHRASE=walletphrase99 FAUCET_ADMIN_TOKEN=admtok123456"
echo '{"db_password":"dbpw12345","wallet_passphrase":"wpp12345"}'
echo "GET /api/x?access_token=qtok1234567 HTTP/1.1"
echo "X-Api-Key: apikeyvalue123"
echo "+ export ZALLET_RPC_PASSWORD=tracevalue1"
echo "docker run -e ZALLET_RPC_PASSWORD=envvalue123 zallet"
echo 'zallet.toml: pwhash = "1a2b3c4ddeadbeefcafe"'
echo "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rXwW1gFWFOEjXk"
echo "authorization: Bearer abcdefghijklmnop"
echo "starting with --rpcpassword s3cr3t2 --datadir /var/lib/zallet"
echo "posted to https://hooks.slack.com/services/T00/B00/XXXXsecret"
echo "also posted to http://hooks.slack.com/services/T11/B11/PLAINsecret"
echo "and to https://discord.com/api/webhooks/123/dscrdSECRET"
echo "curl -u faucet:hunter2isalongpassword http://127.0.0.1:8232/"
echo "curl --user faucet:hunter2isalongpassword -X POST http://127.0.0.1:8232/"
echo "retrying: curl -u admin:notinanyenvfile1 https://upstream.example/rpc"
echo "restored account from xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi"
echo '{"method":"z_sendmany","password":"pw0rdinjson","seed":"abandon abandon artichoke"}'
echo "imported spending key secret-extended-key-test1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"
echo "uview1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx0qq viewing key installed"
echo "extended fvk zxviews1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsxqqqqqqqqqqqqqq"
echo "RATE_LIMIT_SALT=9f3c1de4b7a25086f2e1"
echo "BACKUP_PASSPHRASE=correct horse battery staple"
echo "ZSNAP_AGE_IDENTITY=AGE-SECRET-KEY-1QQZZPLPGYQQZQZQZQZQZQZQZQZQZQ"
echo "-----BEGIN RSA PRIVATE KEY-----"
echo "MIIEpAIBAAKCAQEAv0kQ9zZ1YnHhw2qk3l4mN5oP6qR7sT8uV9wX0yZ1aB2cD3eF4g"
echo "-----END RSA PRIVATE KEY-----"
echo "txid 4f9c1b2a3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8 confirmed"
echo "miner: height 4336381: no solution in this window"
echo "zallet: authentication failed for user faucet from 10.0.0.7"
echo "zebrad: DNS seeder returned 12 peers, seed nodes ok"
echo "zsnap-export: zsnap-import authenticates with the same key"
# LINES THIS REPO SENDS TODAY. drift-report.sh puts the first one in a page, and every
# log prefix in the tree is built with `date -u`; a rule that blanks the token after any
# -u destroyed both.
echo "config findings on z3box. Findings and their fixes: journalctl -u faucet-drift-report -n 200"
echo "prefix built with date -u +%FT%TZ"
echo "docker run -u 1000:1000 zallet"
echo "watchdog: liveness probe to https://faucet.example.org/api/ready timed out after 5s"
echo "watchdog: tip oracle unreachable: GET https://hosh.zec.rocks returned 502"
echo "faucet-backup: ABORT: cannot read the age identity at identity.txt"
echo "turnstile site key 0x4AAAAAAApublicsitekey is in the page"
echo "ABORT: could not read zebra rpc cookie file at /run/zebra"
echo "short lived cache entry"
# THE THRESHOLD, from both sides. Five characters after the separator is prose and six is
# a credential; without a fixture at each side the number is invisible to the suite.
echo "watchdog: token: fifth attempt, backing off"
echo "zallet: token=abc123 accepted"
echo "zebra rpc cookie name is __cookie__value1 on this box"
echo "metrics push endpoint https://metrics.example.org/push answered 204"
echo "peers from seed1.example.org,seed2.example.org accepted"
echo "zsnap-import: gpg: decryption failed, tried /kQ9zZ1YnHhw2qk3l4mN5oP6qR7sT8uV9wX0yZ1a"
# Prose that CONTAINS a keyword and is followed by a separator. The single-token rule
# matched any word containing one, so these lost their numbers.
echo "zebrad: DNS seeder: 12 peers returned, all good"
echo "watchdog: tokens: 3 remaining in the bucket"
echo "backup: credentials: none required for this step"
echo "add ZALLET_RPC_PASSWORD= to /etc/faucet/faucet.env"
# The four end-of-line names, spelled the way this box spells variables. The rule got a
# prefix class and no suffix class, so one character before the separator escaped it.
echo "AUTHORIZATION_HEADER: Bearer leakedbearertoken1"
echo "PASSPHRASE_HINT=correct horse battery staple hint"
echo "MNEMONIC_WORDS=abandon abandon abandon artichoke"
echo "COOKIE_VALUE=__cookie__:9a8b7c6d5e4f3a2b1c0d"
# JSON whose value is not a quoted string: an array, a bare literal, a python dict repr.
echo '{"headers":{"Authorization":["Bearer arraybearer123"]}}'
echo '{"password":null,"api_key":["leakedinarray1"]}'
# MORE THAN ONE ELEMENT. The rule stopped at the first comma, so a recovery phrase
# printed as a JSON array put 23 of its 24 words on the webhook - and the one-element
# fixture above could not see it.
echo '{"seed": ["abandon","ability","able","about","above","absent","absorb","abstract"]}'
echo '{"authorization": ["Bearer aaa1secret","Bearer bbb2secret"]}'
echo '{"credentials": {"user": "faucet", "password": "nestedpw123"}}'
# AND ONE THE QUOTED RULE CANNOT SAVE: the inner key is not itself a secret name, so only
# the object rule reaches it. Without this the object rule could be deleted outright and
# the suite stayed green - the previous fixture was redacted by its neighbour.
echo '{"seed": {"entropy": 8877665544332211, "words": 24}}'
# The bare-scalar threshold, from both sides, the way its neighbour's is pinned.
echo '{"token": abc123, "height": 3396810}'
echo '{"token": abc12, "height": 3396810}'
# A secret whose VALUE carries regex metacharacters: stage 1 builds a pattern out of it,
# so an unescaped one either matches the wrong thing or breaks the filter entirely.
echo "connecting with pw a.b*c[d]e+f(g) now"
# The four end-of-line names with an ordinary suffix, which the suffix class now reaches.
echo "AUTHORIZATION_HEADER: Bearer leakedbearertoken1"
echo "PASSPHRASE_HINT=correct horse battery staple hint"
# And the bare header form, whose value is two tokens and five characters of scheme.
echo "Authorization: Basic ZmF1Y2V0Omh1bnRlcjI="
# Lines a Rust service prints when a config key is wrong. A quoted key in PROSE is not a
# JSON member, and blanking after it takes the fix instruction with it.
echo 'zallet: unknown field "seed": expected one of height, network, account'
echo 'serde: invalid type at "api_key": expected string, found integer'
echo "zaino: field 'cookie': not present in the response envelope"
echo 'error: missing key "token": add it to /etc/faucet/faucet.env and restart'
echo '{"reserveTaz": 950, "tokens": 4, "height": 3396810}'
# Config whose NAME contains one of the four end-of-line keywords. MINING.md names the
# first as the setting that decides whether the miner needs auth, and the miner unit has
# OnFailure=faucet-alert@.
echo "enable_cookie_auth = false"
echo "ZEBRA_RPC__ENABLE_COOKIE_AUTH=false and the miner needs no auth"
echo "cookie_path: /var/run/auth/.cookie, threads: 4"
echo "cookies: 3 accepted, 0 rejected"
echo "authorization_mode: basic, retries: 2"
echo "mnemonic_length: 24 words expected"
echo "add ZALLET_COOKIE_PATH= to /etc/faucet/faucet.env"
echo "{'password': 'pythonreprsecret1'}"
J
chmod +x "$T/bin/journalctl"
bash "$ALERT" --unit zallet.service > /dev/null 2>&1

# Stage 1: the box's own secrets, matched by value wherever they appear.
check "a password in a URL does not leave the box" "! grep -q 'hunter2' '$HOOK_LOG'"
check "and neither does the same password behind curl -u, which no name rule sees" \
  "! grep -q 'faucet:hunter2isalongpassword' '$HOOK_LOG'"
check "the rate-limit salt, which de-anonymises the ledger's IP hashes if it leaks" \
  "! grep -q '9f3c1de4b7a25086f2e1' '$HOOK_LOG'"
check "and a multi-word backup passphrase, which no single-token rule would reach" \
  "! grep -q 'correct horse battery' '$HOOK_LOG'"
# One base64 passphrase in 64 begins with a slash, and a value-shape skip dropped those.
check "a passphrase that happens to start with a slash is still a passphrase" \
  "! grep -q 'kQ9zZ1YnHhw2qk3l4mN5oP6qR7sT8uV9wX0yZ1a' '$HOOK_LOG'"
# A short value is a placeholder, and blanking it would erase the word from ordinary lines.
check "a secret whose value is regex metacharacters is escaped, not treated as a pattern" \
  "! grep -q 'a.b\\*c\\[d\\]e' '$HOOK_LOG' && grep -q 'connecting with pw' '$HOOK_LOG'"
check "a secret under 12 characters is NOT matched by value: it would erase log text" \
  "grep -q 'short lived cache entry' '$HOOK_LOG'"
# SIX, not five and not seven. A five-character token after a separator is prose ("retries:
# fifth"); a six-character one is short but it is a value. Both sides are pinned or the
# number is a comment.
check "five characters after a separator is prose and survives" \
  "grep -q 'token: fifth attempt, backing off' '$HOOK_LOG'"
check "and six is a value and does not" "! grep -q 'abc123 accepted' '$HOOK_LOG'"
# Each stage-1 guard has a fixture only IT can save, or deleting one of them changes
# nothing and the narrowing is not actually pinned.
check "a name the old broad list took (*COOKIE*) is not a secret, and its value survives" \
  "grep -q '__cookie__value1 on this box' '$HOOK_LOG'"
check "a selected name whose value is a plain URL is configuration, and the URL survives" \
  "grep -q 'https://metrics.example.org/push answered 204' '$HOOK_LOG'"
check "and a name saying PUBLIC is not a secret however it is spelled" \
  "grep -q 'seed1.example.org,seed2.example.org accepted' '$HOOK_LOG'"

# Stage 2: key material we do not hold, so only its shape can catch it.
check "a Zcash spending key does not leave the box" \
  "! grep -q 'qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' '$HOOK_LOG'"
check "and neither does a unified viewing key" "! grep -q 'uview1qw508d6' '$HOOK_LOG'"
check "nor a sapling extended full viewing key" "! grep -q 'zxviews1qw508d6' '$HOOK_LOG'"
check "nor an age identity, which is what the snapshot backups are encrypted to" \
  "! grep -q 'AGE-SECRET-KEY-1QQZZ' '$HOOK_LOG'"
# The old rule rewrote the BEGIN line and passed every base64 line after it through.
check "a PEM block loses its BODY, not just its header" \
  "! grep -q 'MIIEpAIBAAKCAQEA' '$HOOK_LOG'"
check "and says so, rather than the block vanishing without a trace" \
  "grep -q 'key material removed' '$HOOK_LOG'"

# Stage 3: names, narrowly.
check "a named password" "! grep -q 's3cr3tvalue' '$HOOK_LOG'"
# THE SPELLINGS PRODUCTION USES. The name rule could not see an underscore or a hyphen,
# so it matched `password=` and nothing this box writes.
check "an underscored variable name, which is how every secret here is spelled" \
  "! grep -q 'pgsecretvalue123' '$HOOK_LOG' && ! grep -q 'notinanyfile2' '$HOOK_LOG'"
check "two secrets on one line, both of them" \
  "! grep -q 'walletphrase99' '$HOOK_LOG' && ! grep -q 'admtok123456' '$HOOK_LOG'"
check "an underscored key inside a JSON body" \
  "! grep -q 'dbpw12345' '$HOOK_LOG' && ! grep -q 'wpp12345' '$HOOK_LOG'"
check "a token in a URL query string" "! grep -q 'qtok1234567' '$HOOK_LOG'"
check "an HTTP header spelled with hyphens" "! grep -q 'apikeyvalue123' '$HOOK_LOG'"
check "a set -x trace line and a docker -e argument" \
  "! grep -q 'tracevalue1' '$HOOK_LOG' && ! grep -q 'envvalue123' '$HOOK_LOG'"
# The field zallet-rpc-auth documents, and the one #176 printed into tooling output.
check "zallet's pwhash, which is the field the RPC auth incident was about" \
  "! grep -q '1a2b3c4ddeadbeefcafe' '$HOOK_LOG'"
check "a JWT keeps its header and loses its signature" \
  "! grep -q 'dBjftJeZ4CVPmB92K27uhbUJU1p1rXwW1gFWFOEjXk' '$HOOK_LOG'"
# The end-of-line rule had a prefix class and no suffix class, so one character between
# the keyword and the separator escaped it - the same shape as the bug above, fixed on
# three rules and left on the fourth, which carries the two highest-value names here.
check "an underscored Authorization header, which is how a dump spells it" \
  "! grep -q 'leakedbearertoken1' '$HOOK_LOG'"
check "an underscored passphrase and mnemonic, both multi-word" \
  "! grep -q 'correct horse battery staple hint' '$HOOK_LOG' && ! grep -q 'abandon abandon abandon artichoke' '$HOOK_LOG'"
check "and zebra's cookie in its on-disk form, which is not hex alone" \
  "! grep -q '9a8b7c6d5e4f3a2b1c0d' '$HOOK_LOG'"
# A JSON value that is not a quoted string was invisible to both JSON-aware rules.
check "a secret inside a JSON array" \
  "! grep -q 'arraybearer123' '$HOOK_LOG' && ! grep -q 'leakedinarray1' '$HOOK_LOG'"
# The rule stopped at the first comma, so element 2 onward went out. One element could
# not show that; a 24-word recovery phrase is the case that matters.
check "EVERY element of a multi-element array, not just the first" \
  "! grep -q 'ability' '$HOOK_LOG' && ! grep -q 'abstract' '$HOOK_LOG' && ! grep -q 'bbb2secret' '$HOOK_LOG'"
check "and a nested object under a secret key, whole" \
  "! grep -q 'nestedpw123' '$HOOK_LOG'"
check "including one whose inner keys are ordinary, which only the object rule reaches" \
  "! grep -q '8877665544332211' '$HOOK_LOG'"
# SIX characters is a value, five is prose - the same line its neighbour draws, and drawn
# in the same place, or the number is a comment.
check "a six-character bare JSON value is redacted" "! grep -q 'abc123, ' '$HOOK_LOG'"
check "and a five-character one is prose, so the line keeps its shape" \
  "grep -q 'abc12, ' '$HOOK_LOG' && grep -q '3396810' '$HOOK_LOG'"
check "the bare Authorization header, whose scheme is only five characters" \
  "! grep -q 'ZmF1Y2V0Omh1bnRlcjI' '$HOOK_LOG'"
check "and one in a python dict repr, which is what a traceback prints" \
  "! grep -q 'pythonreprsecret1' '$HOOK_LOG'"
check "one passed as a flag" "! grep -q 's3cr3t2' '$HOOK_LOG'"
check "a bearer token, whose value is two tokens from its name" "! grep -q 'abcdefghijklmnop' '$HOOK_LOG'"
# A credential this box does NOT hold, so only the -u rule can catch it: with the fixture
# using a password from secrets.env, deleting that rule changed nothing.
check "a curl -u credential we do not hold, which no value or name rule reaches" \
  "! grep -q 'notinanyenvfile1' '$HOOK_LOG'"
check "and an extended private key, which is a wallet restored from a seed" \
  "! grep -q '9s21ZrQH143K3QTDL' '$HOOK_LOG'"
check "a password inside a JSON body" "! grep -q 'pw0rdinjson' '$HOOK_LOG'"
check "and a multi-word seed phrase inside one" "! grep -q 'abandon abandon artichoke' '$HOOK_LOG'"
check "the webhook's own path, which IS the credential for that format" "! grep -q 'XXXXsecret' '$HOOK_LOG'"
check "on http as well as https, since the rule used to be anchored on the scheme" \
  "! grep -q 'PLAINsecret' '$HOOK_LOG'"
check "and a Discord webhook path, which had no fixture and so no coverage" \
  "! grep -q 'dscrdSECRET' '$HOOK_LOG'"
check "the message says something was redacted rather than dropping the line" "grep -q 'REDACTED' '$HOOK_LOG'"

# THE OTHER DIRECTION. Over-redaction is not a safe default: these are lines this repo's
# own scripts print, and blanking to end of line on the words auth, seed and cookie turned
# "authentication failed" into "authentication REDACTED", which loses the fault.
check "the TXID survives: it is public and it is the first thing an operator needs" \
  "grep -q '4f9c1b2a3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8' '$HOOK_LOG'"
check "and an ordinary line is untouched" "grep -q 'no solution in this window' '$HOOK_LOG'"
check "an auth FAILURE still says who failed and from where" \
  "grep -q 'authentication failed for user faucet from 10.0.0.7' '$HOOK_LOG'"
check "a DNS seeder line keeps its peer count" "grep -q 'seeder returned 12 peers, seed nodes ok' '$HOOK_LOG'"
check "and zsnap's own wording about authenticating survives" \
  "grep -q 'zsnap-import authenticates with the same key' '$HOOK_LOG'"
check "as does the cookie path in an abort message" "grep -q 'rpc cookie file at /run/zebra' '$HOOK_LOG'"
# THE OTHER HALF OF THE PREFIX RULE. It matches any word CONTAINING a keyword, so a
# separator after ordinary prose put REDACTED where a number was. Five characters or
# fewer after the separator is prose, not a credential.
check "a seeder line keeps its peer count even with a colon after the word" \
  "grep -q 'DNS seeder: 12 peers returned' '$HOOK_LOG'"
check "and a token bucket keeps its number" "grep -q 'tokens: 3 remaining' '$HOOK_LOG'"
check "and 'credentials: none required' still says none" "grep -q 'credentials: none required' '$HOOK_LOG'"
# audit-drift.sh prints this verbatim, and faucet-drift-report reaches the webhook.
check "and the instruction audit-drift prints keeps the file it names" \
  "grep -q 'add ZALLET_RPC_PASSWORD= to /etc/faucet/faucet.env' '$HOOK_LOG'"
# A QUOTED KEY IN PROSE IS NOT A JSON MEMBER. zallet, zaino and the miner are Rust, and
# serde prints "unknown field X: expected one of ..." on a config typo; blanking after it
# takes the list of valid names, or the fix instruction, with it.
check "a serde field error keeps the names it is telling you to use" \
  "grep -q 'expected one of height, network, account' '$HOOK_LOG'"
check "and an invalid-type error keeps what it expected and what it found" \
  "grep -q 'expected string, found integer' '$HOOK_LOG'"
check "and a missing-key error keeps the file it tells you to edit" \
  "grep -q 'add it to /etc/faucet/faucet.env and restart' '$HOOK_LOG'"
check "a JSON member that is an ordinary counter keeps its number" \
  "grep -q 'tokens.*: 4, .*height.*: 3396810' '$HOOK_LOG'"
# NAMES CONTAINING ONE OF THE FOUR END-OF-LINE KEYWORDS. All ordinary config; blanking to
# end of line took the path, the counts and the retry budget.
check "the setting that decides whether the miner needs auth keeps its value" \
  "grep -q 'enable_cookie_auth = false' '$HOOK_LOG' && grep -q 'ENABLE_COOKIE_AUTH=false and the miner' '$HOOK_LOG'"
check "a cookie PATH is a path, and the thread count beside it survives" \
  "grep -q 'cookie_path: /var/run/auth/.cookie, threads: 4' '$HOOK_LOG'"
check "counts, modes and lengths are not credentials" \
  "grep -q 'cookies: 3 accepted, 0 rejected' '$HOOK_LOG' && grep -q 'authorization_mode: basic, retries: 2' '$HOOK_LOG' && grep -q 'mnemonic_length: 24 words expected' '$HOOK_LOG'"
check "and the same fix instruction with a cookie-shaped name" \
  "grep -q 'add ZALLET_COOKIE_PATH= to /etc/faucet/faucet.env' '$HOOK_LOG'"
# The -u rule needs the value to LOOK like credentials, or it eats the one actionable
# token in the page drift-report sends and the prefix on every line in the tree.
check "journalctl -u <unit> survives: it is the fix drift-report's own page tells you to run" \
  "grep -q 'journalctl -u faucet-drift-report -n 200' '$HOOK_LOG'"
check "and date -u, which builds every log prefix here" "grep -q 'date -u +%FT%TZ' '$HOOK_LOG'"
check "and a uid:gid, which is a colon but not a credential" "grep -q -- '-u 1000:1000' '$HOOK_LOG'"
# Stage 1 blanks a value ANYWHERE, so selecting public configuration by name erases the
# address the page is about and collapses two causes into one dedup key.
check "the faucet's own URL survives: a page about it that cannot name it is no page" \
  "grep -q 'https://faucet.example.org/api/ready timed out' '$HOOK_LOG'"
check "and the tip oracle's, which is a different cause and must stay one" \
  "grep -q 'GET https://hosh.zec.rocks returned 502' '$HOOK_LOG'"
check "a variable whose name says PUBLIC is not treated as a secret" \
  "grep -q '0x4AAAAAAApublicsitekey' '$HOOK_LOG'"
check "and a name ending _FILE points AT a secret rather than being one" \
  "grep -q 'age identity at identity.txt' '$HOOK_LOG'"
check "the unit is still named" "grep -q 'unit FAILED: zallet.service' '$HOOK_LOG'"

echo "== alerts: redaction is on the SEND path, so every caller gets it"
# The tail was the only thing filtered at first. The watchdog interpolates a reason it
# parsed out of a live /api/ready body and drift-report pushes audit findings; both go
# through send() as a plain message and neither is a journal tail.
# alerts_env makes a fresh scratch dir, so the fixture is written again rather than
# reached for across $T values.
alerts_env
cat > "$T/secrets.env" <<'E'
ZALLET_RPC_PASSWORD=hunter2isalongpassword
E
export FAUCET_ALERT_SECRET_FILES="$T/secrets.env"
bash "$ALERT" --now "faucet NOT READY for 31 min. Reason: wallet said rpcpassword=leakedviareason" > /dev/null 2>&1
check "a plain --now message is redacted too, not just a --unit tail" \
  "! grep -q 'leakedviareason' '$HOOK_LOG' && grep -q 'faucet NOT READY for 31 min' '$HOOK_LOG'"
unset FAUCET_ALERT_SECRET_FILES

echo "== alerts: a filter that does not answer pages anyway, with the text withheld"
# redact is a three-process pipeline and there is no set -e. An empty result used to be
# sent as an empty message, and because the cooldown key is computed on redacted text,
# every other cause then hashed to the same empty key and was held back for an hour:
# three different outages, one blank page, then silence.
alerts_env
cat > "$T/secrets.env" <<'E'
ZALLET_RPC_PASSWORD=hunter2isalongpassword
E
export FAUCET_ALERT_SECRET_FILES="$T/secrets.env"
printf '#!/usr/bin/env bash\nexit 1\n' > "$T/bin/awk"; chmod +x "$T/bin/awk"
# NOT --now: that sets DEDUP=0, and the cooldown is the whole point here. With the held
# path, a blank message makes every cause share one key and the second one is swallowed.
bash "$ALERT" "🚨 NEEDS YOU: ZEBRA IS DOWN" > "$T/broken.log" 2>&1
check "a page still goes out when the filter fails" "grep -q 'NEEDS YOU' '$HOOK_LOG'"
check "and it carries no message text, because unfiltered text is exactly what cannot be trusted" \
  "! grep -q 'ZEBRA IS DOWN' '$HOOK_LOG' && grep -q 'the text is withheld' '$HOOK_LOG'"
check "the journal says the filter is the reason, not the alert" \
  "grep -q 'REDACTION FAILED' '$T/broken.log'"
# Distinct causes must stay distinct, or the first failure mutes the box for an hour.
: > "$HOOK_LOG"
bash "$ALERT" "🚨 NEEDS YOU: DISK FULL on /" > /dev/null 2>&1
check "a DIFFERENT cause is not held back as a repeat of the first" "grep -q 'NEEDS YOU' '$HOOK_LOG'"
: > "$HOOK_LOG"
bash "$ALERT" "🚨 NEEDS YOU: ZALLET CRASH-LOOPING" > /dev/null 2>&1
check "and nor is a third: one broken filter must not mute the box for an hour" "grep -q 'NEEDS YOU' '$HOOK_LOG'"
rm -f "$T/bin/awk"

echo "== alerts: the secrets file is parsed the way the shell would read it"
alerts_env
# A quoted value: the file is written for `source`, so the quotes are the shell's, not
# part of the secret. Loading them into the literal makes stage 1 match nothing.
printf 'ZALLET_RPC_PASSWORD="quotedsecretvalue1"\n' > "$T/quoted.env"
printf '#!/usr/bin/env bash\necho "boom: quotedsecretvalue1 in a log line"\n' > "$T/bin/journalctl"
chmod +x "$T/bin/journalctl"
FAUCET_ALERT_SECRET_FILES="$T/quoted.env" bash "$ALERT" --unit zallet.service > /dev/null 2>&1
check "the send arrived, so the negative below means something" \
  "grep -q 'unit FAILED: zallet.service' '$HOOK_LOG'"
check "a quoted value is unquoted before it becomes a pattern" \
  "! grep -q 'quotedsecretvalue1' '$HOOK_LOG'"
# alert.sh runs as root from systemd, so an unreadable file means someone ran it by hand
# and the strongest stage is off. That has to be said, not silently skipped.
alerts_env
printf 'ZALLET_RPC_PASSWORD=unreadablesecret1\n' > "$T/locked.env"; chmod 000 "$T/locked.env"
if [ -r "$T/locked.env" ]; then
  echo "  skip: running as root, an unreadable file cannot be modelled"
else
  FAUCET_ALERT_SECRET_FILES="$T/locked.env" bash "$ALERT" "hello" > "$T/locked.log" 2>&1
  check "an unreadable secrets file is named in the journal, not skipped in silence" \
    "grep -q 'cannot read .*locked.env' '$T/locked.log'"
fi
chmod 644 "$T/locked.env"

echo "== alerts: stage 1 reads the files this box actually keeps secrets in"
alerts_env
# Six files, not three. The default list is the contract, so it is asserted rather than
# left to whoever remembers: backup.env was missing and BACKUP_PASSPHRASE was then covered
# by nothing at all.
for f in alerts backup zsnap metrics miner watchdog; do
  check "the default secret-file list names $f.env" \
    "grep -q '/etc/faucet/$f.env' '$REPO/deploy/z3/alert.sh'"
done
check "and the app's own env, where the wallet RPC password and the rate-limit salt live" \
  "grep -q 'deploy/z3/faucet.env' '$REPO/deploy/z3/alert.sh'"
# A file written on Windows keeps the CR on the value, so nothing matched and nothing said so.
printf 'ZALLET_RPC_PASSWORD=crlfsecretvalue123\r\n' > "$T/crlf.env"
printf '#!/usr/bin/env bash\necho "boom: crlfsecretvalue123 in a log line"\n' > "$T/bin/journalctl"
chmod +x "$T/bin/journalctl"
FAUCET_ALERT_SECRET_FILES="$T/crlf.env" bash "$ALERT" --unit zallet.service > /dev/null 2>&1
check "the send arrived, so the negative below is not asserted against an empty file" \
  "grep -q 'unit FAILED: zallet.service' '$HOOK_LOG'"
check "a CRLF secrets file still redacts, rather than silently doing nothing" \
  "! grep -q 'crlfsecretvalue123' '$HOOK_LOG'"
# The variable is documented as operator-settable, and a path with a space in it silently
# disabled the strongest stage.
mkdir -p "$T/dir with space"
printf 'ZALLET_RPC_PASSWORD=spacedsecretvalue1\n' > "$T/dir with space/s.env"
printf '#!/usr/bin/env bash\necho "boom: spacedsecretvalue1 in a log line"\n' > "$T/bin/journalctl"
chmod +x "$T/bin/journalctl"
: > "$HOOK_LOG"
# A DIFFERENT UNIT, because the cooldown keys on the unit and a held-back send leaves an
# empty log that every `! grep` assertion passes on. The first version of this check
# reused zallet.service and proved nothing.
FAUCET_ALERT_SECRET_FILES="$T/dir with space/s.env" bash "$ALERT" --unit zebra.service > /dev/null 2>&1
check "the send actually arrived, so what follows is not asserted against an empty file" \
  "grep -q 'unit FAILED: zebra.service' '$HOOK_LOG'"
check "a secrets path containing a space is read, not split into fragments that do not exist" \
  "! grep -q 'spacedsecretvalue1' '$HOOK_LOG'"

echo "== alerts: the older WATCHDOG_ALERT_URL still works after upgrade"
alerts_env; unset FAUCET_ALERT_URL
export WATCHDOG_ALERT_URL="http://127.0.0.1:$HOOK_PORT/hook"
bash "$ALERT" "legacy config" > /dev/null 2>&1
check "legacy var honoured" "grep -q 'legacy config' '$HOOK_LOG'"

# NOTE: these sit ABOVE `kill $HOOK_PID` on purpose. Appended after it, they ran
# against a dead receiver: nothing arrived, and the negative assertion
# "does not use the wake-someone wording" PASSED on an empty file. A vacuous pass
# is why the positive assertions beside it are not optional.
# ── BEST-EFFORT TIER: a feature-net stall must not read like an outage (#327) ────────
#
# Every failure on this box routes through one handler with one wording, so a Crosslink
# node wobbling at 3am arrives looking exactly like the TAZ faucet being down. One means
# nobody can get testnet coins; the other means an experimental chain hiccupped.
#
# The repo decides which is which, the same way enabled-units decides enablement, so the
# tiering goes through review rather than being edited on the box.

echo "== alert: a best-effort unit does not read like a faucet outage"
alerts_env
BE="$T/best-effort"
printf '# comment\nctaz-node.service\nctaz-rpc@.service\n' > "$BE"
FAUCET_BEST_EFFORT_UNITS="$BE" bash "$ALERT" --unit ctaz-node.service > "$T/be.log" 2>&1
check "it still alerts, rather than swallowing the failure" "[ -s '$HOOK_LOG' ]"
check "and says it is NOT an outage" "grep -q 'NOT a faucet outage' '$HOOK_LOG'"
check "and does not use the wake-someone wording" "! grep -q 'unit FAILED' '$HOOK_LOG'"
check "the unit is still named, or the alert costs an SSH session to act on" \
  "grep -q 'ctaz-node.service' '$HOOK_LOG'"

echo "== alert: A UNIT NOT ON THE LIST IS STILL LOUD"
# The mirror, and the one that matters: without it the tier could be applied to
# everything and these tests would still pass.
alerts_env
printf 'ctaz-node.service\n' > "$BE"
FAUCET_BEST_EFFORT_UNITS="$BE" bash "$ALERT" --unit faucet-watchdog.service > "$T/loud.log" 2>&1
check "an unlisted unit uses the outage wording" "grep -q 'unit FAILED' '$HOOK_LOG'"
check "and is not softened" "! grep -q 'NOT a faucet outage' '$HOOK_LOG'"

echo "== alert: a TEMPLATE INSTANCE matches the template line"
# ctaz-rpc@3-172.17.0.2:9.service must match `ctaz-rpc@.service`. Without stripping the
# instance, the one unit type that produces the most failures could never be tiered and
# the list would silently do nothing for it.
alerts_env
printf 'ctaz-rpc@.service\n' > "$BE"
FAUCET_BEST_EFFORT_UNITS="$BE" bash "$ALERT" --unit 'ctaz-rpc@3-172.17.0.2:9.service' > "$T/inst.log" 2>&1
check "an instance is tiered by its template" "grep -q 'NOT a faucet outage' '$HOOK_LOG'"

echo "== alert: FAILS LOUD when the list cannot be read"
# Under-alerting is the worse failure, so every ambiguity resolves toward noise. A
# missing file must not quietly make everything best-effort.
alerts_env
FAUCET_BEST_EFFORT_UNITS="$T/no-such-file" bash "$ALERT" --unit ctaz-node.service > "$T/nofile.log" 2>&1
check "no list means nothing is best-effort" "grep -q 'unit FAILED' '$HOOK_LOG'"
check "and the cTAZ unit is loud, despite being the one we would tier" \
  "! grep -q 'NOT a faucet outage' '$HOOK_LOG'"

echo "== alert: a separate best-effort channel is used when one is configured"
# The harness runs ONE receiver, so this asserts the URL SWITCH rather than a second
# inbox: pointing the best-effort channel at a dead port must send there and fail, not
# quietly fall back to the paging channel. A fallback would defeat the whole tier.
alerts_env
printf 'ctaz-node.service\n' > "$BE"
FAUCET_BEST_EFFORT_UNITS="$BE" \
  FAUCET_ALERT_BESTEFFORT_URL="http://127.0.0.1:1/nope" \
  bash "$ALERT" --unit ctaz-node.service > "$T/split.log" 2>&1
check "the paging channel received NOTHING" "[ ! -s '$HOOK_LOG' ]"
check "and the failure to reach the best-effort channel is reported" \
  "grep -q 'POST FAILED' '$T/split.log'"

# ── ONCE PER CAUSE PER HOUR ──────────────────────────────────────────────────────────
# faucet-metrics.sh runs every 30 s and alerts inside a per-filesystem loop; every 2-minute
# unit carries OnFailure=. The day Signal came alive that was a channel one low disk away
# from 2,880 messages. The sender holds repeats, and these prove the exact shape of that.

echo "== alerts: the same alert twice inside the window is sent ONCE and counted"
alerts_env
bash "$ALERT" "disk low: / has 9% free" > "$T/d1.log" 2>&1; rc1=$?
bash "$ALERT" "disk low: / has 8% free" > "$T/d2.log" 2>&1; rc2=$?
check "first send exits 0" "[ $rc1 -eq 0 ]"
check "the repeat also exits 0, because held back is a decision, not a failure" "[ $rc2 -eq 0 ]"
check "the webhook saw exactly one" "[ \"\$(grep -c 'disk low' '$HOOK_LOG')\" = 1 ]"
check "the journal says HELD BACK and counts it" "grep -q 'HELD BACK.*1 so far' '$T/d2.log'"
check "a changed number is the same cause" "grep -q '9% free' '$HOOK_LOG' && ! grep -q '8% free' '$HOOK_LOG'"
check "and the first, delivered send is logged as sent" "grep -q 'sent: disk low' '$T/d1.log'"

echo "== alerts: the MAGNITUDE survives the key: 40 behind and 4000 behind are two causes"
alerts_env
bash "$ALERT" "zebra still 40 blocks behind" > /dev/null 2>&1
bash "$ALERT" "zebra still 4000 blocks behind" > /dev/null 2>&1
check "both reached the webhook" "[ \"\$(grep -c 'blocks behind' '$HOOK_LOG')\" = 2 ]"
bash "$ALERT" "zebra still 45 blocks behind" > "$T/m3.log" 2>&1
check "while 45 is the same cause as 40" "grep -q 'HELD BACK' '$T/m3.log'"

echo "== alerts: A SEND THAT FAILS DOES NOT START THE WINDOW, so the next repeat is tried"
# The first version recorded the cause before the POST. With the bridge restarting at the
# moment the disk crossed the floor, the one failed send burned the hour and the channel
# heard nothing about a disk filling to 0%.
alerts_env; export FAUCET_ALERT_URL="http://127.0.0.1:$HOOK_PORT/FAIL"
bash "$ALERT" "disk low: / has 9% free" > "$T/f1.log" 2>&1; rc1=$?
export FAUCET_ALERT_URL="http://127.0.0.1:$HOOK_PORT/hook"
bash "$ALERT" "disk low: / has 8% free" > "$T/f2.log" 2>&1; rc2=$?
check "the failed POST is reported as a failure" "[ $rc1 -ne 0 ] && grep -q 'POST FAILED' '$T/f1.log'"
check "the repeat after it is SENT, not held" "[ $rc2 -eq 0 ] && grep -q 'sent: disk low' '$T/f2.log'"
check "and it reached the webhook" "grep -q 'disk low' '$HOOK_LOG'"
check "and the failure left no record to hold anything back" "! grep -q 'HELD BACK' '$T/f2.log'"

echo "== alerts: a send with no encoder does not start the window either"
alerts_env
mkdir -p "$T/nobin3"
for b in bash curl date hostname sed tr cat head mkdir grep cut sha256sum cksum flock find; do
  src="$(command -v $b 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$T/nobin3/$b"
done
PATH="$T/nobin3" FAUCET_ALERT_STATE_DIR="$T/alert-state" bash "$ALERT" "disk low: / has 9% free" > "$T/ne1.log" 2>&1; rc1=$?
bash "$ALERT" "disk low: / has 9% free" > "$T/ne2.log" 2>&1; rc2=$?
check "the encoder-less send exits 4" "[ $rc1 -eq 4 ]"
check "the same message with an encoder is then SENT" "[ $rc2 -eq 0 ] && grep -q 'sent: disk low' '$T/ne2.log'"

echo "== alerts: --now is never held, for callers that already send one per episode"
# The watchdog's FIXED and NEEDS YOU have different first lines. Held under a cooldown, the
# NEEDS YOU that follows a FIXED inside the hour would be dropped, and a green tick would
# be the channel's last word about a faucet that is down.
alerts_env
bash "$ALERT" --now "🚨 NEEDS YOU: faucet NOT READY for 30 min. Reason: node syncing." > /dev/null 2>&1
bash "$ALERT" --now "✅ FIXED: faucet is READY again." > /dev/null 2>&1
bash "$ALERT" --now "🚨 NEEDS YOU: faucet NOT READY for 30 min. Reason: node syncing." > "$T/now3.log" 2>&1
check "all three reached the channel" "[ \"\$(grep -c 'faucet' '$HOOK_LOG')\" = 3 ]"
check "the second NEEDS YOU was not held" "! grep -q 'HELD BACK' '$T/now3.log' && grep -q 'sent:' '$T/now3.log'"
check "--now without a message is a usage error, not a silent send of nothing" "bash '$ALERT' --now >/dev/null 2>&1; [ \$? -eq 64 ]"

echo "== alerts: a cooldown that is not a number WARNS and uses the default, never silently off"
alerts_env; export FAUCET_ALERT_COOLDOWN_SECONDS=1h
bash "$ALERT" "disk low: / has 9% free" > "$T/c1.log" 2>&1
bash "$ALERT" "disk low: / has 9% free" > "$T/c2.log" 2>&1
check "the journal names the bad value" "grep -q \"WARNING: FAUCET_ALERT_COOLDOWN_SECONDS='1h' is not a whole number\" '$T/c1.log'"
check "and the default cooldown is in force" "grep -q 'HELD BACK' '$T/c2.log' && [ \"\$(grep -c 'disk low' '$HOOK_LOG')\" = 1 ]"
bash "$ALERT" --self-test > "$T/c3.log" 2>&1
check "and the self-test, the command an operator runs to check this, shows the warning too" "grep -q 'WARNING: FAUCET_ALERT_COOLDOWN_SECONDS' '$T/c3.log' && grep -q \"cooldown=3600s (configured: '1h')\" '$T/c3.log'"

echo "== alerts: a cooldown longer than a day is capped, with a warning, not a bash error and dedup off"
alerts_env; export FAUCET_ALERT_COOLDOWN_SECONDS=99999999999999999999
bash "$ALERT" "disk low: / has 9% free" > "$T/big1.log" 2>&1
bash "$ALERT" "disk low: / has 9% free" > "$T/big2.log" 2>&1
check "no bash error about integer expressions" "! grep -q 'integer expression' '$T/big1.log'"
check "warns and caps at a day" "grep -q 'more than a day; using 86400' '$T/big1.log'"
check "and the cooldown is in force" "grep -q 'HELD BACK' '$T/big2.log'"

echo "== alerts: a record from the FUTURE (clock stepped back) does not hold anything"
alerts_env
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
for f in "$T"/alert-state/*; do
  [ -f "$f" ] || continue; [ "$(basename "$f")" = ".lock" ] && continue
  printf '%s 0\n' "$(( $(date -u +%s) + 86400 ))" > "$f"
done
bash "$ALERT" "disk low: / has 9% free" > "$T/fut.log" 2>&1
check "sent despite a record stamped tomorrow" "grep -q 'sent: disk low' '$T/fut.log'"

echo "== alerts: A STATE DIR THAT IS NOT OURS gets no records and no deletes, however it is spelled"
# The first guard was a denylist of names and "/etc/" with a trailing slash walked past it;
# that review run deleted /etc/fstab. Ownership, not names: a directory with anyone else's
# files in it and no .faucet-alerts marker is never touched. Tested against a WRITABLE fake
# /etc, so the assertion is about the guard and not about the harness lacking root.
alerts_env
mkdir -p "$T/fake-etc"; : > "$T/fake-etc/fstab"; : > "$T/fake-etc/environment"; : > "$T/fake-etc/adduser.conf"
touch -d '30 days ago' "$T/fake-etc/fstab" "$T/fake-etc/environment" "$T/fake-etc/adduser.conf" 2>/dev/null || true
for spelling in "$T/fake-etc/" "$T/fake-etc/." "$T//fake-etc" "$T/fake-etc/../fake-etc"; do
  FAUCET_ALERT_STATE_DIR="$spelling" bash "$ALERT" "disk low: / has 9% free" > "$T/sys.log" 2>&1
  check "sent, with the dir spelled '$spelling'" "grep -q 'sent: disk low' '$T/sys.log'"
  check "and dedup is OFF with the reason" "grep -q 'dedup OFF: .* is not a directory this script owns' '$T/sys.log'"
done
check "every pre-existing file survived" "[ -e '$T/fake-etc/fstab' ] && [ -e '$T/fake-etc/environment' ] && [ -e '$T/fake-etc/adduser.conf' ]"
check "and nothing of ours was written there" "[ \"\$(ls -A '$T/fake-etc' | wc -l | tr -d ' ')\" = 3 ]"

echo "== alerts: an EMPTY directory is adopted and marked; a fresh path is created and marked"
alerts_env
mkdir -p "$T/empty-dir"
FAUCET_ALERT_STATE_DIR="$T/empty-dir" bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
check "the empty directory got the marker and a record" "[ -e '$T/empty-dir/.faucet-alerts' ] && [ \"\$(ls '$T/empty-dir' | wc -l | tr -d ' ')\" = 1 ]"
check "the default fresh path got the marker too" "[ -e '$T/alert-state/.faucet-alerts' ] || { bash '$ALERT' 'x' >/dev/null 2>&1; [ -e '$T/alert-state/.faucet-alerts' ]; }"

echo "== alerts: THE LOCK COVERS A SLOW POST, so simultaneous identical alerts deliver once"
# Measured in review, twice. First the record was written outside the lock: 8 of 8. Then
# the timestamp was read before the lock, so every waiter queued behind the winner's
# 1.2 s POST judged the fresh record with a stale clock and the clock-skew guard let it
# through: 8 of 8 again, invisible against an instant receiver. This receiver is slow.
alerts_env; export FAUCET_ALERT_URL="http://127.0.0.1:$HOOK_PORT/slow"
# `wait` with NO arguments would also wait for the suite's background receiver, for ever.
par_pids=""
for i in 1 2 3 4 5 6 7 8; do bash "$ALERT" "disk low: / has 9% free" > "$T/par$i.log" 2>&1 & par_pids="$par_pids $!"; done
# shellcheck disable=SC2086
wait $par_pids
check "exactly one reached the webhook" "[ \"\$(grep -c 'disk low' '$HOOK_LOG')\" = 1 ]"
check "and the other seven were held back, not lost or errored" "[ \"\$(cat '$T'/par*.log | grep -c 'HELD BACK')\" = 7 ]"
check "and none gave up on the lock" "! grep -q 'could not take the cooldown lock' '$T'/par*.log"

echo "== alerts: DISTINCT causes do not queue behind each other's POST"
# One shared lock made eight causes wait for eight sends in a row and, at curl's ceiling,
# blow the 30 s wait and fail fully open. Per-cause locks: eight causes against the slow
# receiver finish in about one POST's time, and every one is delivered.
alerts_env; export FAUCET_ALERT_URL="http://127.0.0.1:$HOOK_PORT/slow"
start=$(date +%s); par_pids=""
# Distinct in WORDS: digits are blanked from the key, so "cause 1" and "cause 2" would be one cause.
for w in alpha bravo charlie delta echo foxtrot golf hotel; do bash "$ALERT" "cause $w is distinct" > "$T/dist-$w.log" 2>&1 & par_pids="$par_pids $!"; done
# shellcheck disable=SC2086
wait $par_pids; took=$(( $(date +%s) - start ))
check "all eight distinct causes reached the webhook" "[ \"\$(grep -c 'is distinct' '$HOOK_LOG')\" = 8 ]"
check "in parallel, not one POST after another (under 6 s for eight 1.2 s POSTs)" "[ $took -lt 6 ]"
check "and none was held back or gave up" "! grep -qE 'HELD BACK|could not take' '$T'/dist-*.log"

echo "== alerts: a lock file this process cannot open is dedup OFF in words, not two raw errors"
alerts_env
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1   # creates the dir and one key's lock
lockf="$(ls "$T"/alert-state/.lock.* | head -1)"; chmod 444 "$lockf"
# the lock is opened for writing; a read-only lock file must not be a shower of errors
if [ "$(id -u)" != 0 ]; then
  bash "$ALERT" "disk low: / has 9% free" > "$T/lockro.log" 2>&1
  check "sent" "grep -q 'sent: disk low' '$T/lockro.log'"
  check "dedup OFF, in the designed words" "grep -q 'dedup OFF: cannot open the cooldown lock' '$T/lockro.log' && ! grep -q 'Permission denied\|Bad file descriptor' '$T/lockro.log'"
else
  ok "lock-permission case skipped: running as root, mode bits do not apply"
  ok "lock-permission case skipped: running as root, mode bits do not apply"
fi
chmod 644 "$lockf"

echo "== alerts: a sub-minute cooldown says seconds, not '0 min'"
alerts_env; export FAUCET_ALERT_COOLDOWN_SECONDS=30
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
for f in "$T"/alert-state/*; do
  [ -f "$f" ] || continue; case "$(basename "$f")" in .*) continue ;; esac
  read -r _ n < "$f" || n=0; printf '%s %s\n' "$(( $(date -u +%s) - 120 ))" "${n:-0}" > "$f"
done
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
check "the note is in seconds" "grep -q 'held back in the last 30s' '$HOOK_LOG'"

echo "== alerts: the weekly sweep touches ONLY forty-hex key files, never a neighbour"
# In a directory we adopted and someone later shared, `[0-9a-f]*` matched access.log,
# backup.tar.gz and faucet.db. Only the exact key shape may go.
alerts_env
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1   # creates and marks the dir
for f in access.log backup.tar.gz faucet.db 0001-patch data.json; do : > "$T/alert-state/$f"; done
: > "$T/alert-state/0123456789abcdef0123456789abcdef01234567"      # an old key of ours
touch -d '10 days ago' "$T"/alert-state/* 2>/dev/null || true
bash "$ALERT" "another cause entirely" > /dev/null 2>&1
check "the neighbours all survived" "[ -e '$T/alert-state/access.log' ] && [ -e '$T/alert-state/backup.tar.gz' ] && [ -e '$T/alert-state/faucet.db' ] && [ -e '$T/alert-state/0001-patch' ] && [ -e '$T/alert-state/data.json' ]"
check "and the stale key of ours was swept" "[ ! -e '$T/alert-state/0123456789abcdef0123456789abcdef01234567' ]"

echo "== alerts: a directory holding only our LOCK files is ours too (the marker lost, the locks kept)"
alerts_env
mkdir -p "$T/locks-only"; : > "$T/locks-only/.lock.0123456789abcdef0123456789abcdef01234567"
FAUCET_ALERT_STATE_DIR="$T/locks-only" bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
FAUCET_ALERT_STATE_DIR="$T/locks-only" bash "$ALERT" "disk low: / has 9% free" > "$T/lo2.log" 2>&1
check "adopted, and the repeat is held back" "[ -e '$T/locks-only/.faucet-alerts' ] && grep -q 'HELD BACK' '$T/lo2.log'"
mkdir -p "$T/lock-stranger"; : > "$T/lock-stranger/.lock.not-ours-at-all"
FAUCET_ALERT_STATE_DIR="$T/lock-stranger" bash "$ALERT" "disk low: / has 9% free" > "$T/ls.log" 2>&1
check "while a .lock.* that is not our shape keeps the directory someone else's" "grep -q 'dedup OFF' '$T/ls.log' && [ ! -e '$T/lock-stranger/.faucet-alerts' ]"

echo "== alerts: lock files expire a month after their cause stopped firing"
alerts_env
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
: > "$T/alert-state/.lock.0123456789abcdef0123456789abcdef01234567"
touch -d '40 days ago' "$T/alert-state/.lock.0123456789abcdef0123456789abcdef01234567" 2>/dev/null || true
bash "$ALERT" "another cause entirely" > /dev/null 2>&1
check "a 40-day-old lock of a dead cause is gone" "[ ! -e '$T/alert-state/.lock.0123456789abcdef0123456789abcdef01234567' ]"
check "while the live cause's lock stays" "ls '$T'/alert-state/.lock.* >/dev/null 2>&1"

echo "== alerts: a directory holding only OUR files is ours, so two first-callers cannot disown it"
alerts_env
mkdir -p "$T/ours-only"; : > "$T/ours-only/.faucet-alerts"; : > "$T/ours-only/.lock"
: > "$T/ours-only/0123456789abcdef0123456789abcdef01234567"
rm "$T/ours-only/.faucet-alerts"   # the marker is what a racing peer might not have written yet
FAUCET_ALERT_STATE_DIR="$T/ours-only" bash "$ALERT" "disk low: / has 9% free" > "$T/ours.log" 2>&1
check "adopted, not refused" "! grep -q 'dedup OFF' '$T/ours.log' && [ -e '$T/ours-only/.faucet-alerts' ]"

echo "== alerts: a marked directory that is not writable is dedup OFF, not a shower of Permission denied"
alerts_env
mkdir -p "$T/ro-marked"; : > "$T/ro-marked/.faucet-alerts"; chmod 555 "$T/ro-marked"
FAUCET_ALERT_STATE_DIR="$T/ro-marked" bash "$ALERT" "disk low: / has 9% free" > "$T/ro.log" 2>&1
chmod 755 "$T/ro-marked"
check "sent" "grep -q 'sent: disk low' '$T/ro.log'"
check "dedup OFF, in the designed words" "grep -q 'dedup OFF' '$T/ro.log' && ! grep -q 'Permission denied' '$T/ro.log'"

echo "== alerts: leading zeros are a legal spelling of a number"
alerts_env; export FAUCET_ALERT_COOLDOWN_SECONDS=0003600
bash "$ALERT" --self-test > "$T/lz.log" 2>&1
check "no warning, and the cooldown is 3600" "! grep -q 'WARNING: FAUCET_ALERT_COOLDOWN' '$T/lz.log' && grep -q 'cooldown=3600s' '$T/lz.log'"

echo "== alerts: the held-back count is on the FIRST line, where a phone preview shows it"
alerts_env
printf '#!/usr/bin/env bash\necho "line one of the tail"\necho "line two of the tail"\n' > "$T/bin/journalctl"; chmod +x "$T/bin/journalctl"
bash "$ALERT" --unit zsnap-export.service > /dev/null 2>&1
bash "$ALERT" --unit zsnap-export.service > /dev/null 2>&1
for f in "$T"/alert-state/*; do
  [ -f "$f" ] || continue; case "$(basename "$f")" in .*) continue ;; esac
  read -r _ n < "$f" || n=0; printf '%s %s\n' "$(( $(date -u +%s) - 7200 ))" "${n:-0}" > "$f"
done
bash "$ALERT" --unit zsnap-export.service > /dev/null 2>&1
check "the note follows the unit name on the first line, not the journal tail" "grep -q 'unit FAILED: zsnap-export.service (+1 identical held back in the last 60 min)' '$HOOK_LOG'"

echo "== alerts: a first alert of a new cause leaves NO shell error in the journal"
alerts_env
bash "$ALERT" "a brand new cause" > "$T/new.log" 2>&1
check "no 'No such file' from the state read" "! grep -q 'No such file' '$T/new.log'"

echo "== alerts: a DIFFERENT cause inside the window still goes out"
alerts_env
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
bash "$ALERT" "node is behind by 40 blocks" > /dev/null 2>&1
check "both causes reached the webhook" "grep -q 'disk low' '$HOOK_LOG' && grep -q 'node is behind' '$HOOK_LOG'"

echo "== alerts: when the window has passed, the next one is sent WITH the held-back count"
alerts_env
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
# Age the record by rewriting its timestamp: the file holds "<epoch> <held back>".
for f in "$T"/alert-state/*; do
  [ -f "$f" ] || continue
  [ "$(basename "$f")" = ".lock" ] && continue
  read -r _ n < "$f" || n=0; printf '%s %s\n' "$(( $(date -u +%s) - 7200 ))" "${n:-0}" > "$f"
done
bash "$ALERT" "disk low: / has 7% free" > "$T/d4.log" 2>&1
check "exactly two reached the webhook: the first, and the one after the window" "[ \"\$(grep -c 'disk low' '$HOOK_LOG')\" = 2 ]"
check "the second carries the count of what was held back" "grep -q '+2 identical held back in the last 60 min' '$HOOK_LOG'"
check "and the count is reset for the next window" "bash '$ALERT' 'disk low: / has 7% free' >/dev/null 2>&1; [ \"\$(grep -c 'disk low' '$HOOK_LOG')\" = 2 ]"

echo "== alerts: instances of one template unit are ONE cause, whatever their ids look like"
# Real instance ids differ in width (@10-3385354-0, @100000-3396810-0): a key that only
# blanked digits kept them apart and five failures of one broker paged five times.
alerts_env
printf '#!/usr/bin/env bash\necho "node did not answer"\n' > "$T/bin/journalctl"; chmod +x "$T/bin/journalctl"
bash "$ALERT" --unit 'ctaz-rpc@10-3385354-0.service' > /dev/null 2>&1
bash "$ALERT" --unit 'ctaz-rpc@100000-3396810-0.service' > "$T/u2.log" 2>&1
bash "$ALERT" --unit 'ctaz-rpc@101127-3691924-0.service' > /dev/null 2>&1
check "one page for three instances of different widths" "[ \"\$(grep -c 'unit FAILED' '$HOOK_LOG')\" = 1 ]"
check "the second is held back, not lost" "grep -q 'HELD BACK' '$T/u2.log'"
bash "$ALERT" --unit 'faucet-watchdog.service' > /dev/null 2>&1
check "a different unit is a different cause and goes out" "grep -q 'faucet-watchdog.service' '$HOOK_LOG'"

echo "== alerts: the self-test is NEVER held back, it is a person asking"
alerts_env
bash "$ALERT" --self-test > /dev/null 2>&1
bash "$ALERT" --self-test > "$T/st5.log" 2>&1
check "both self-tests reached the channel" "[ \"\$(grep -c 'self-test from' '$HOOK_LOG')\" = 2 ]"
check "and the second passed" "grep -q 'SELF-TEST PASSED' '$T/st5.log'"
check "the self-test log states the cooldown, so a muted-looking channel has a visible cause" "grep -q 'cooldown=3600s' '$T/st5.log'"

echo "== alerts: FAUCET_ALERT_COOLDOWN_SECONDS=0 turns it off"
alerts_env; export FAUCET_ALERT_COOLDOWN_SECONDS=0
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
check "both were sent" "[ \"\$(grep -c 'disk low' '$HOOK_LOG')\" = 2 ]"

echo "== alerts: a state dir that cannot be written FAILS TOWARD NOISE, not silence"
alerts_env; export FAUCET_ALERT_STATE_DIR="$T/not-a-dir/deeper"
: > "$T/not-a-dir"   # a file where a directory is needed, so mkdir -p fails
bash "$ALERT" "disk low: / has 9% free" > "$T/ro1.log" 2>&1
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
check "both were sent" "[ \"\$(grep -c 'disk low' '$HOOK_LOG')\" = 2 ]"
check "and the journal says why repeats are not being held" "grep -q 'dedup OFF' '$T/ro1.log'"

echo "== alerts: a message that is NOT sent leaves no cooldown record behind"
# Unconfigured returns 3 before the dedup runs; otherwise the first real send after
# configuring the channel would be held back by a failure that never reached anyone.
alerts_env; unset FAUCET_ALERT_URL
bash "$ALERT" "disk low: / has 9% free" > /dev/null 2>&1
check "no state was written" "[ ! -d '$T/alert-state' ] || [ -z \"\$(ls -A '$T/alert-state' 2>/dev/null | grep -v '^.lock$')\" ]"

echo "== alerts: with no JSON encoder it refuses loudly instead of sending junk"
alerts_env
mkdir -p "$T/nobin"
# A PATH with neither jq nor python3, but with the tools alert.sh still needs.
# bash itself must be reachable, plus what alert.sh actually calls.
for b in bash curl date hostname sed tr cat; do
  src="$(command -v $b 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$T/nobin/$b"
done
PATH="$T/nobin" bash "$ALERT" "would be malformed" > "$T/noenc.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "says it cannot encode" "grep -q 'CANNOT SEND' '$T/noenc.log'"
check "explains the refusal is deliberate" "grep -q 'Refusing rather than sending a malformed body' '$T/noenc.log'"
# A control send FIRST, or "nothing reached the webhook" is true of a receiver that is
# simply not listening - which is how this passed for a whole round below the teardown.
bash "$ALERT" "the receiver is alive" > /dev/null 2>&1
check "the receiver is alive, so the negative below means something" \
  "grep -q 'the receiver is alive' '$HOOK_LOG'"
check "nothing reached the webhook" "! grep -q 'would be malformed' '$HOOK_LOG'"

echo "== alerts: a quote in the operator prefix cannot break the body"
alerts_env
FAUCET_ALERT_PREFIX='[fau"cet]' bash "$ALERT" "hello" > /dev/null 2>&1
# Parsing an EMPTY file is not parsing JSON. Count the lines first, or a prefix that broke
# the body would pass this by producing nothing at all.
check "the send arrived, so there is a body to validate" "[ -s '$HOOK_LOG' ]"
check "body is still valid JSON" "python3 -c \"import json,sys;ls=[l for l in open('$HOOK_LOG') if l.strip()];sys.exit(1) if not ls else [json.loads(l) for l in ls]\""
check "and the quoted prefix is in it, escaped rather than dropped" "grep -q 'fau' '$HOOK_LOG'"

# EVERY case that asserts on $HOOK_LOG must sit ABOVE this line. Two of them did not:
# "nothing reached the webhook" passed against an empty file, and the JSON-validity check
# parsed ZERO lines, so a prefix that DID break the body would have passed. Both now run
# above, and both assert something arrived first.
kill "$HOOK_PID" 2>/dev/null

echo "== alerts: the webhook URL never reaches the log (it is a credential)"
alerts_env
export FAUCET_ALERT_URL="http://127.0.0.1:$HOOK_PORT/hook?token=SUPERSECRETTOKEN"
bash "$ALERT" --self-test > "$T/leak.log" 2>&1
check "the token is absent from the log" "! grep -q 'SUPERSECRETTOKEN' '$T/leak.log'"
check "it says set, not the value" "grep -q 'url=set' '$T/leak.log'"
alerts_env; unset FAUCET_ALERT_URL
bash "$ALERT" --self-test > "$T/leak2.log" 2>&1
check "unconfigured still says UNSET" "grep -q 'url=UNSET' '$T/leak2.log'"

echo "== alerts: a tab in the body is encoded, not silently mangled"
# Journal output is full of tabs and JSON forbids raw control characters, so
# this gets its own receiver rather than sharing the suite's.
alerts_env
TAB_PORT=$((HOOK_PORT + 1)); TAB_LOG="$T/tabhook.log"; : > "$TAB_LOG"
python3 - "$TAB_PORT" "$TAB_LOG" <<'TABPY' >/dev/null 2>&1 &
import http.server,sys
port,logf=int(sys.argv[1]),sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length',0))
        open(logf,'a').write(self.rfile.read(n).decode()+"\n")
        self.send_response(204); self.end_headers()
    def log_message(self,*a): pass
http.server.HTTPServer(("127.0.0.1",port),H).serve_forever()
TABPY
TAB_PID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null -X POST -d '{}' "http://127.0.0.1:$TAB_PORT/up" && break; sleep 0.25; done
: > "$TAB_LOG"
export FAUCET_ALERT_URL="http://127.0.0.1:$TAB_PORT/hook"
bash "$ALERT" "$(printf 'unit failed\ncolumn1\tcolumn2')" > "$T/tab.log" 2>&1
check "the send succeeded" "[ $? -eq 0 ]"
check "the tab and newline survive as real characters after decoding" "python3 -c \"import json;b=[json.loads(l) for l in open('$TAB_LOG') if l.strip()][-1];t=b.get('text','');assert chr(9) in t and chr(10) in t, repr(t)\""
kill "$TAB_PID" 2>/dev/null

echo "== alerts: self-test names the real cause, not a plausible one"
# rc=4 (no encoder) used to print "the webhook rejected the POST", sending an
# operator to debug Slack when the fix is installing jq.
alerts_env
mkdir -p "$T/nobin2"
for b in bash curl date hostname sed tr cat; do
  src="$(command -v $b 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$T/nobin2/$b"
done
PATH="$T/nobin2" bash "$ALERT" --self-test > "$T/st4.log" 2>&1
check "exits 4, distinct from a rejected webhook" "[ $? -eq 4 ]"
check "blames the missing encoder" "grep -q 'no jq and no python3' '$T/st4.log'"
check "does NOT blame the webhook" "! grep -q 'webhook rejected' '$T/st4.log'"
