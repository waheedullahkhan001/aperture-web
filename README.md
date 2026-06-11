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
    npm run dev          # serves site/ at http://localhost:5500

Run the backend separately (dev profile, port 8080, permissive CORS):

    cd ../aperture-service && ./gradlew bootRun

`site/js/config.js` points the site at `http://localhost:8080` when served from
port 5500, and at the page's own origin everywhere else (production). To target
another backend without editing code, run once in the browser console:

    localStorage.setItem('aperture.apiBase', 'http://localhost:8081')

Dev-profile notes: the database is in-memory (wiped on restart) and OTP emails are
printed to the backend log instead of being sent.

## Deploy

    npm install && npm run setup:prod

Serve `site/` with Nginx **on the same origin as the API** (the prod CORS config
only allows cross-origin access to the public watch endpoint). Required routes:

    location /api/      { proxy_pass http://backend:8080; }
    location /actuator/ { proxy_pass http://backend:8080; }
    # alert emails link to /watch/<uuid>?t=... — serve the watch page for those:
    location ~ ^/watch/ { try_files /watch.html =404; }
    location /          { try_files $uri $uri/ =404; }
