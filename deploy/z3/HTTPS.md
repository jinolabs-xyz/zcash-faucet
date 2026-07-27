# Putting the faucet on a real domain with HTTPS

Caddy gets a Let's Encrypt certificate on its own and keeps it renewed. There
is no certbot, no cron job and no key to copy around. What you owe it is a
domain pointing at the box and ports 80 and 443 open, in that order, before
it starts.

## 1. DNS first

Point the hostname at the box and wait for it to resolve. Caddy proves
ownership over HTTP, so a name that does not resolve yet means a failed
challenge and a retry backoff.

```
A     faucet.example.org    172.235.26.235
AAAA  faucet.example.org    <the box's IPv6, if it has one>
```

Publish an `AAAA` record only if the box actually answers on that address:
Let's Encrypt prefers IPv6 when it exists, and a stale record fails the
challenge even though the site works fine over IPv4.

Check it from somewhere that is not the box:

```bash
dig +short faucet.example.org
```

## 2. Ports open

`cloud-init.yaml` already opens both:

```bash
ufw allow 80/tcp    # ACME HTTP-01 challenge, and the redirect to HTTPS
ufw allow 443/tcp   # the site
```

Port 80 stays open permanently. It is not just for the first certificate:
renewals use it too, and Caddy serves the HTTP→HTTPS redirect there.

## 3. Tell the stack the name

On a fresh box, set it in `cloud-init.yaml` before pasting (the one
placeholder line):

```yaml
- echo "faucet.example.org" > /etc/faucet-domain
```

On a running box:

```bash
echo "faucet.example.org" > /etc/faucet-domain
cd /opt/zcash-faucet && FAUCET_DOMAIN=faucet.example.org ./deploy/deploy.sh
```

`deploy.sh` passes it to the overlay, the compose file hands it to Caddy as
`FAUCET_DOMAIN`, and the Caddyfile uses it as the site address. Unset, it
falls back to `:80`, plain HTTP, which is the smoke-test mode and not what
you want in production.

## 4. Verify

```bash
curl -sS -D - -o /dev/null https://faucet.example.org/api/health
curl -sSI http://faucet.example.org | head -1     # expect a 308 to https
```

You should see `HTTP/2 200`, plus the headers the Caddyfile sets:
`Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy` and
`X-Frame-Options`. The certificate itself:

```bash
echo | openssl s_client -connect faucet.example.org:443 -servername faucet.example.org 2>/dev/null \
  | openssl x509 -noout -issuer -dates
```

## What the config does beyond terminating TLS

- **Security headers.** HSTS (one year, subdomains), `nosniff`,
  `strict-origin-when-cross-origin` and `X-Frame-Options: DENY`. The faucet
  is never meant to be embedded, and a framed claim button is a clickjacking
  surface. The `Server` header is stripped so the proxy version is not
  advertised.
- **Admin API off.** Caddy's admin socket has no use on a single-box deploy
  and leaving it off removes a config-rewrite surface from the container.
- **Access logs to stdout**, so they land in the same docker logging pipeline
  as everything else, with `/api/health` and `/api/ready` skipped. Those two
  are most of the traffic (the watchdog polls them constantly) and say
  nothing worth keeping.
- **No ACME contact email** by default. Let's Encrypt accepts an account with
  no contact, and a fake address is worse than none. For expiry notices, add
  `email you@example.org` to the global block in the Caddyfile.

## When it does not work

**Certificate never arrives.** Check DNS resolves from off-box, check 80 is
reachable from the internet, then read the logs:

```bash
docker compose -f docker-compose.faucet.yml logs caddy | grep -iE 'certificate|acme|challenge'
```

**Hitting Let's Encrypt rate limits** (five failures per account per hostname
per hour) while debugging: point Caddy at the staging CA, which has generous
limits and issues untrusted certificates, by adding to the global block:

```
acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
```

Remove it and restart Caddy for a real certificate. Staging and production
certificates live in the same `caddy_data` volume, so nothing is lost either
way.

**Changing the domain later.** Update `/etc/faucet-domain`, re-run
`deploy.sh`, and Caddy gets a certificate for the new name. The old one stays
in the volume and expires quietly.

**Losing the `caddy_data` volume** means re-issuing certificates from
scratch. That is usually fine, but it counts against the rate limit above, so
avoid a `docker compose down -v` on a box that is already live.
