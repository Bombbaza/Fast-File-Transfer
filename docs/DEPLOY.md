# Deploying Fast File Transfer on a VPS

This guide runs the `fft` server as a hardened, always-on service behind HTTPS on
a Linux VPS. The server speaks **plain HTTP** by design — you terminate TLS at a
reverse proxy in front of it.

> Replace every `example.com`, path, and placeholder below with your own values.
> Never commit your real `.env` or token.

## Prerequisites

- A Linux VPS (Ubuntu/Debian shown; adapt for others) with a public IP
- **Node.js ≥ 20** installed
- A domain name pointing at the VPS (an `A`/`AAAA` record for `fft.example.com`)
- Ports **80** and **443** open to the internet; the app port (**8787**) stays local

## 1. Get the code and build

```bash
sudo mkdir -p /opt/fft && sudo chown "$USER" /opt/fft
git clone https://github.com/Bombbaza/Fast-File-Transfer.git /opt/fft
cd /opt/fft
npm ci
npm run build      # compiles to dist/
```

## 2. Configure

```bash
cp .env.example .env
chmod 600 .env                       # keep it private
# set a strong token (replaces the placeholder line in .env):
sed -i "s|^FFT_TOKEN=.*|FFT_TOKEN=$(openssl rand -hex 32)|" .env
```

Edit `.env` for production (see the README's Configuration table for all keys):

```ini
FFT_HOST=127.0.0.1          # bind to loopback only — the proxy reaches it, the internet does not
FFT_PORT=8787
FFT_STORAGE_DIR=/var/lib/fft/data
FFT_MAX_FILE_BYTES=21474836480   # 20 GiB; raise/lower to taste
FFT_QUOTA_BYTES=-1               # or a per-principal cap
FFT_RETENTION_DAYS=30            # auto-expire completed files
# FFT_TOKEN was appended above
```

Binding to `127.0.0.1` is the simplest hardening: only the reverse proxy on the
box can reach the app; the raw HTTP port is never exposed.

```bash
sudo mkdir -p /var/lib/fft/data
sudo chown -R fft:fft /var/lib/fft   # the service user from step 3
```

## 3. Run it as a systemd service

Create a dedicated, unprivileged user and a unit file so the server restarts on
crash and starts on boot.

```bash
sudo useradd --system --home /opt/fft --shell /usr/sbin/nologin fft || true
sudo chown -R fft:fft /opt/fft
```

`/etc/systemd/system/fft.service`:

```ini
[Unit]
Description=Fast File Transfer server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=fft
Group=fft
WorkingDirectory=/opt/fft
EnvironmentFile=/opt/fft/.env
ExecStart=/usr/bin/node /opt/fft/dist/cli.js serve
Restart=on-failure
RestartSec=3

# hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/fft
StateDirectory=fft

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fft
sudo systemctl status fft          # should be active (running)
journalctl -u fft -f               # follow logs
```

Verify locally before adding the proxy:

```bash
curl -s http://127.0.0.1:8787/healthz   # -> {"ok":true,"protocol":"/v1"}
```

## 4. Put it behind HTTPS (reverse proxy)

Pick one. **Caddy** is the least effort — it obtains and renews certificates
automatically.

### Option A — Caddy (recommended)

Install Caddy, then `/etc/caddy/Caddyfile`:

```caddyfile
fft.example.com {
    reverse_proxy 127.0.0.1:8787
    request_body {
        max_size 0          # 0 = unlimited; the app enforces FFT_MAX_FILE_BYTES itself
    }
}
```

```bash
sudo systemctl reload caddy
```

That's it — Caddy fetches a Let's Encrypt cert for `fft.example.com` on first hit.

### Option B — nginx + Certbot

`/etc/nginx/sites-available/fft` (then symlink into `sites-enabled/`):

```nginx
server {
    listen 80;
    server_name fft.example.com;

    location / {
        proxy_pass         http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $remote_addr;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # large/streaming transfers: don't buffer, don't cap the body
        client_max_body_size        0;     # app enforces its own size limit
        proxy_request_buffering      off;   # stream chunk uploads straight through
        proxy_buffering              off;   # stream downloads straight through
        proxy_read_timeout           3600s; # allow long transfers
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/fft /etc/nginx/sites-enabled/fft
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d fft.example.com   # provisions + auto-renews TLS
```

> The buffering/body-size settings matter for a file server: without them nginx
> may buffer whole chunks to disk or reject large requests.

## 5. Firewall

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow OpenSSH
sudo ufw enable
# Note: 8787 is NOT opened — only the proxy (on localhost) reaches it.
```

## 6. Use it

From any client, point at the HTTPS endpoint:

```bash
node dist/cli.js send ./bigfile.zip --to https://fft.example.com --token "$FFT_TOKEN"
node dist/cli.js recv <id> --from https://fft.example.com --token "$FFT_TOKEN" --out ./bigfile.zip
```

## Operations

- **Logs:** `journalctl -u fft -f`
- **Update:**
  ```bash
  cd /opt/fft && sudo -u fft git pull && sudo -u fft npm ci && sudo -u fft npm run build
  sudo systemctl restart fft
  ```
- **Storage:** files live under `FFT_STORAGE_DIR`; `FFT_RETENTION_DAYS` auto-expires
  completed files. Back up that directory if transfers must survive a rebuild.
- **Health/monitoring:** poll `GET /healthz` (no auth) from your uptime checker.
- **Restart safety:** in-progress uploads resume client-side; completed files are
  unaffected by restarts.

## Security checklist

- [ ] Strong `FFT_TOKEN` (`openssl rand -hex 32`), never committed
- [ ] `.env` is `chmod 600`, owned by the service user
- [ ] App bound to `127.0.0.1`; only the proxy is public
- [ ] HTTPS enforced at the proxy (the app is plain HTTP)
- [ ] Firewall allows only 80/443/SSH
- [ ] Runs as the unprivileged `fft` user, not root
- [ ] Set `FFT_QUOTA_BYTES` / `FFT_MAX_FILE_BYTES` if the box is shared or storage is finite

See [`../DESIGN.md`](../DESIGN.md) for the protocol and security model, and the
[README](../README.md) for the full configuration reference.

---

## Deploying the federation relay gateway

The relay gateway runs the same binary as the direct server — federation routes
(`/v1/agents`, `/v1/transfers`) are added automatically. Follow steps 1–5 above,
then apply the adjustments below.

### Additional environment variables

Append to `/opt/fft/.env`:

```ini
# Relay token — ALL agents must present this as "Authorization: Bearer <token>".
# Generate a strong value: openssl rand -hex 32
FFT_TOKEN=<strong-relay-token>
```

You may also want a longer retention period for in-flight transfers:

```ini
FFT_RETENTION_DAYS=7        # keep committed files for 7 days
FFT_SESSION_IDLE_MINUTES=120
```

### systemd unit for the relay gateway

`/etc/systemd/system/fft-relay.service`:

```ini
[Unit]
Description=Fast File Transfer relay gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=fft
Group=fft
WorkingDirectory=/opt/fft
EnvironmentFile=/opt/fft/.env
ExecStart=/usr/bin/node /opt/fft/dist/cli.js serve
Restart=on-failure
RestartSec=3

# hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/fft
StateDirectory=fft

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fft-relay
sudo systemctl status fft-relay
curl -s http://127.0.0.1:8787/healthz   # -> {"ok":true,"mode":"federation"}
```

### HTTPS reverse proxy for the relay gateway

Use the same Caddy or nginx blocks from step 4. Point your agents at the HTTPS
URL:

```bash
# Caddy (recommended — auto TLS)
# /etc/caddy/Caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787
    request_body {
        max_size 0
    }
}
```

### Security checklist for the relay gateway

- [ ] Strong `FFT_TOKEN` (`openssl rand -hex 32`), never committed
- [ ] `.env` is `chmod 600`, owned by the service user
- [ ] Gateway bound to `127.0.0.1`; only the TLS proxy is public
- [ ] HTTPS enforced at the proxy (the gateway is plain HTTP)
- [ ] Firewall: only 80/443/SSH exposed
- [ ] Runs as the unprivileged `fft` user, not root
- [ ] Consider replacing the default `bearerAgentAuth` with a scheme that
      cryptographically binds each agent's identity (JWT, mTLS, HMAC challenge)
- [ ] Set `FFT_RETENTION_DAYS` / `FFT_QUOTA_BYTES` to limit per-agent storage

See [FEDERATION.md](./FEDERATION.md) for the protocol specification.
