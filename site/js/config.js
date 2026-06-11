// Where the Spring Boot API lives.
// Production: Nginx serves this site on the SAME origin as the API, so '' (relative
// URLs) is correct. Local dev: the site runs on python http.server :5500 while the
// backend runs separately on :8080, so we point there explicitly.
// For ad-hoc testing against another backend, set an override once in the console:
//   localStorage.setItem('aperture.apiBase', 'http://localhost:8081')
const override = localStorage.getItem('aperture.apiBase');
export const API_BASE = override ?? (location.port === '5500' ? 'http://localhost:8080' : '');
