# Test fixtures

**`expired-localhost.{crt,key}.pem`** — a self-signed certificate for `localhost`
that expired on 2020-04-01, with its key.

It is checked in on purpose. `scripts/live-probe.test.mjs` needs a genuinely
expired certificate to prove the probe distinguishes "the certificate has
already expired" from "nothing is listening" — `tls.connect` verifies by
default, so an expired certificate fails the *handshake* and never reaches the
days-left branch, which is where the runbook sentence lives.

Generating one at test time needs `openssl req -not_before/-not_after`, which
**did not exist before OpenSSL 3.5**. ubuntu-latest, node:22 and this repo's own
harness image all ship OpenSSL 3.0.x, so that test skipped on every machine that
runs the gate — and with it, the whole handshake-failure branch could be deleted
with `npm test` still green. A file needs no openssl at all.

The key is a throwaway for `localhost`, generated for this purpose, expired
before it was committed, and used only by the test suite. It secures nothing.
