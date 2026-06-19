# Aperture Web Interface

The web tier (Tier 4 / Presentation) of the Aperture emergency recording system:
account management, server recording browsing and playback, Android device pairing,
emergency contacts, alert configuration, and the public live-stream watch page that
alert emails link to.

Plain HTML + vanilla JavaScript (ES modules) + Tailwind CSS + daisyUI. No framework,
no bundler — the only build step compiles one CSS file.

## Layout

| Path | Purpose |
|---|---|
| `site/` | Everything a web server serves. `index.html` is the login page. |
| `site/js/api.js` | The one place that talks to the backend: JWT storage, auto-refresh, errors. |
| `site/js/ui.js` | Shared helpers: escaping, toasts, confirm dialog, form wiring. |
| `site/watch.html` | Public stream viewer — the page emergency contacts open. No login. |
| `styles/input.css` | Tailwind + daisyUI source compiled to `site/assets/app.css`. |

## Requirements

Linux/macOS shell, Node.js 18+, Python 3.7+ (dev server only). `npm ci` is the
reproducible install path (the lockfile pins exact versions).

## Develop

    npm install
    npm run setup        # builds CSS + copies hls.js into site/vendor/
    npm run css:watch    # keep running while editing
    npm run dev          # http://localhost:5500 — serves site/ AND proxies the API + stream

`npm run dev` runs `dev-proxy.mjs` (zero dependencies): it serves `site/` and
reverse-proxies `/api`, `/actuator`, and `/aperture` to the local backend stack at
`http://localhost`. The browser therefore sees ONE origin — which mirrors production
(nginx serves the static site same-origin as the API) and, crucially, is what lets the
MediaMTX HLS `hlsSession` cookie reach the watch page. A cross-origin static server
cannot receive that HttpOnly cookie, so live playback can only be tested same-origin.

`site/js/config.js` uses relative API URLs (`API_BASE = ''`) in both dev and prod,
since both are same-origin. Override from the console only for UI-only work:

    localStorage.setItem('aperture.apiBase', 'http://localhost:8081')

The backend stack (Spring API + MediaMTX + PostgreSQL + nginx + mailpit) runs via
docker compose in `../aperture-service`; `npm run dev` assumes it is up at
`http://localhost`. Outgoing emails (verification + alert) land in mailpit at
http://localhost:8025 — that's where dev OTP codes appear.

    npm run dev:static   # http://localhost:5500, static only, no API proxy
                         # (layout/CSS work offline; set the apiBase override to use it)

## Deploy

    npm install && npm run setup:prod

Serve `site/` with Nginx **on the same origin as the API** (the prod CORS config
only allows cross-origin access to the public watch endpoint). Required routes:

    location /api/      { proxy_pass http://backend:8080; }
    location /actuator/ { proxy_pass http://backend:8080; }
    # alert emails link to /watch/<uuid>?t=... — serve the watch page for those:
    location ~ ^/watch/ { try_files /watch.html =404; }
    location /          { try_files $uri $uri/ =404; }

## Credits

Icons are from [Lucide](https://lucide.dev) (ISC license — permissive, no
attribution required). They are embedded as inline SVG in `site/js/icons.js`
(no icon font, no runtime dependency); `stroke="currentColor"` lets Tailwind
control size and color. Add or change icons by editing the set in that one file.

Vendored runtime libraries (copied into `site/vendor/` by `npm run vendor`, not
committed):
- [hls.js](https://github.com/video-dev/hls.js) — Apache-2.0 — HLS playback on the watch page.
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) — MIT — device-pairing QR code.

Deployment note: `site/js/devices.js` imports `vendor/qrcode.mjs` as an ES module, so
the web server must serve `.mjs` with a JavaScript MIME type (`text/javascript`).
