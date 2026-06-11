// Fills <header data-nav></header> with the shared navbar. Import on every logged-in page.
import { logout } from './api.js';

const LINKS = [
  ['recordings.html', 'Recordings'],
  ['devices.html', 'Devices'],
  ['contacts.html', 'Contacts'],
  ['alerts.html', 'Alerts'],
  ['settings.html', 'Settings'],
];

const here = location.pathname.split('/').pop() || 'index.html';

document.querySelector('[data-nav]').innerHTML = `
  <div class="navbar bg-base-100 shadow-sm flex-wrap">
    <div class="flex-1">
      <a class="btn btn-ghost text-xl" href="recordings.html">Aperture</a>
    </div>
    <ul class="menu menu-horizontal flex-wrap px-1">
      ${LINKS.map(([href, label]) =>
        `<li><a href="${href}" class="${here === href ? 'menu-active' : ''}">${label}</a></li>`).join('')}
      <li><button data-logout>Log out</button></li>
    </ul>
  </div>`;

document.querySelector('[data-logout]').addEventListener('click', logout);
