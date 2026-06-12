// Where the Spring Boot API lives.
// Production: Nginx serves this site on the SAME origin as the API, so '' (relative
// URLs) is correct. Local dev: the site runs on python http.server :5500 while the
// backend runs separately on :8081 (the backend's dev profile sets that port —
// 8080 is taken by an unrelated Docker stack on the dev machine).
// For ad-hoc testing against another backend, set an override once in the console:
//   localStorage.setItem('aperture.apiBase', 'http://localhost:9090')
const override = localStorage.getItem('aperture.apiBase');
export const API_BASE = override ?? (location.port === '5500' ? 'http://localhost:8081' : '');
