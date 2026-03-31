# Lighthouse Scanner

A web app to run Google Lighthouse scans on:
- a **single page** (mobile or desktop), or
- a **full site** (sitemap + crawl) with per-page score output.

It includes:
- Full-site result table with URL filtering/search
- CSV export for full-site results
- Basic production hardening (rate limit, security headers, SSRF guard)
- Health endpoint for uptime checks

---

## Quick Start

```bash
cd /Users/danielboone/Documents/lighthousescanner
nvm use 22
npm install
ALLOW_INTERNAL_SCANS=true npm start
```

Then open: `http://localhost:4173`

---

## Production Quick Start

```bash
cd /path/to/lighthousescanner
nvm use 22
npm install
NODE_ENV=production PORT=4173 CHROME_PATH=/usr/bin/chromium UNLIGHTHOUSE_MAX_ROUTES=50 UNLIGHTHOUSE_CONCURRENCY=2 npm start
```

Using the env file template:
```bash
cp .env.production.example .env
# edit .env with your server-specific values
set -a && source .env && set +a && npm start
```

Notes:
- Do **not** set `ALLOW_INTERNAL_SCANS=true` on a public deployment.
- Put a reverse proxy (Nginx/Caddy) + HTTPS in front of the app.
- Verify health with `GET /health`.

---

## Features

- **Single-page scan**
  - Mobile or desktop emulation
  - Performance, Accessibility, Best Practices, SEO
  - Core metrics (LCP, CLS, TBT, FCP)

- **Full-site scan**
  - Uses Unlighthouse-style discovery (sitemap + crawl)
  - Returns per-URL rows with category scores and average score
  - Search/filter table by URL/status and minimum avg score
  - CSV export button in the UI

- **Operational safeguards**
  - One scan at a time (prevents memory/CPU overload)
  - Rate limiting on scan endpoint
  - Host safety checks for internal/private targets (unless explicitly enabled)

---

## Tech Stack

- Node.js + Express + EJS
- Lighthouse
- `@unlighthouse/core` + `@unlighthouse/client`
- `chrome-launcher`

---

## Requirements

- **Node.js 22+**
- **Google Chrome or Chromium** installed

If Chrome is not on the default path, set:
```bash
CHROME_PATH=/path/to/chrome
```

---

## Local Development

1) Install dependencies:
```bash
npm install
```

2) Start app:
```bash
npm start
```

3) Open:
```text
http://localhost:4173
```

### If scanning localhost/private URLs

By default, internal/private targets are blocked for safety.

Enable local/internal scanning:
```bash
ALLOW_INTERNAL_SCANS=true npm start
```

---

## Usage

1. Enter a URL (`https://example.com`)
2. Choose **Device**:
   - Mobile
   - Desktop
3. Choose **Scope**:
   - Single page
   - Full site
4. Click **Scan**

For full-site results:
- Use **Search pages** to filter rows by URL/status
- Use **Min Avg** to filter by score threshold
- Click **Export CSV** to download results

---

## Environment Variables

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `4173` | App port |
| `NODE_ENV` | `development` | Runtime mode |
| `CHROME_PATH` | _(auto)_ | Explicit Chrome/Chromium binary path |
| `ALLOW_INTERNAL_SCANS` | `false` | Allow localhost/private/internal scan targets |
| `UNLIGHTHOUSE_MAX_ROUTES` | `50` | Cap for full-site URL count |
| `UNLIGHTHOUSE_CONCURRENCY` | auto | Worker concurrency for full-site scan |
| `SITE_SCAN_TIMEOUT_MS` | `2700000` | Full-site timeout in ms |
| `RATE_LIMIT_DISABLED` | `false` | Disable request rate limiting |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate limit window |
| `RATE_LIMIT_MAX` | prod:`20`, dev:`120` | Max scan requests per window |
| `TRUST_PROXY` | `0` | Trust reverse proxy headers (`1` to enable) |

How env vars are loaded:
- The app reads variables from the **process environment**.
- It does **not** auto-load `.env` files by default.
- Use your host/process manager env config (PM2, systemd, cPanel UI, Docker `-e`, etc.).
- For local shell testing, you can load from file with:
  ```bash
  set -a && source .env && set +a && npm start
  ```

---

## Health Check

Endpoint:
```text
GET /health
```

Example response:
```json
{"ok":true,"scanBusy":false,"uptime":123.45}
```

---

## Performance Tuning

To make full-site scans faster:

- Lower route cap:
```bash
UNLIGHTHOUSE_MAX_ROUTES=25
```

- Increase concurrency (if server has resources):
```bash
UNLIGHTHOUSE_CONCURRENCY=2
```

- Combine:
```bash
UNLIGHTHOUSE_MAX_ROUTES=25 UNLIGHTHOUSE_CONCURRENCY=2 npm start
```

Tradeoff: more concurrency and more routes = higher CPU/RAM usage.

---

## Production Deployment (General)

1. Provision server (VPS preferred for Lighthouse workloads)
2. Install Node 22+, Chrome/Chromium, git
3. Clone project and install:
   ```bash
   npm install
   ```
4. Set env vars (`NODE_ENV=production`, `PORT`, `CHROME_PATH`, limits)
5. Run with process manager (PM2/systemd)
6. Put Nginx/Caddy in front with HTTPS
7. Verify `/health`

Recommended for public exposure:
- Keep `ALLOW_INTERNAL_SCANS=false`
- Keep rate limiting enabled
- Add authentication if needed

---

## cPanel Notes

This app can run on cPanel **if** your hosting supports:
- Node.js app hosting (Node 22+),
- long-running app process,
- Chrome/Chromium availability.

Many shared cPanel plans are restrictive for headless browser workloads.
VPS/dedicated cPanel is usually the safer option.

---

## Docker

This repo includes:
- `Dockerfile`
- `.dockerignore`

Build and run:
```bash
docker build -t lighthousescanner .
docker run --rm -p 4173:4173 -e NODE_ENV=production lighthousescanner
```

Then open `http://localhost:4173`.

---

## Troubleshooting

- **`Scan failed: ECONNREFUSED ...`**
  - Chrome likely crashed/closed; verify Chrome install/path.

- **Full-site scans slow**
  - Reduce `UNLIGHTHOUSE_MAX_ROUTES`
  - Tune `UNLIGHTHOUSE_CONCURRENCY`

- **Blocked host/internal target**
  - Expected in safe mode. Set `ALLOW_INTERNAL_SCANS=true` only for trusted/local use.

- **Env vars in `.env` seem ignored**
  - Expected unless your runtime loads `.env` into process environment.
  - Use host-level env config, or load manually in shell with:
    ```bash
    set -a && source .env && set +a && npm start
    ```

---

## Developer Setup Checklist

Use this to onboard quickly:

1. Install Node 22 and Chrome/Chromium.
2. Clone repo and run `npm install`.
3. Start locally:
   ```bash
   nvm use 22
   ALLOW_INTERNAL_SCANS=true npm start
   ```
4. Open `http://localhost:4173`.
5. Verify health at `http://localhost:4173/health`.
6. Run one **single-page** and one **full-site** scan.
7. Export CSV from full-site results to verify end-to-end flow.

---

## Project Structure

```text
.
├── server.js
├── views/
│   └── index.ejs
├── lib/
│   └── url-scan-policy.js
├── scripts/
│   ├── apply-unlighthouse-patch.mjs
│   └── run-site-scan-worker.mjs
├── package.json
├── Dockerfile
└── README.md
```

