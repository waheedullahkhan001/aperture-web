// Where the Spring Boot API lives. Same-origin in BOTH environments:
//   - production: nginx serves this site on the same origin as /api (and /aperture).
//   - dev: `npm run dev` runs dev-proxy.mjs, which serves the site AND proxies /api
//     + /aperture to the local nginx stack — so the browser sees one origin. This is
//     required for the HLS `hlsSession` cookie (a cross-origin static server can never
//     receive that HttpOnly cookie). So '' (relative URLs) is correct everywhere.
// Escape hatch — point the app at another backend from the console (e.g. UI-only
// work via `npm run dev:static`, which has no /api proxy):
//   localStorage.setItem('aperture.apiBase', 'http://localhost:8081')
const override = localStorage.getItem('aperture.apiBase');
export const API_BASE = override ?? '';
