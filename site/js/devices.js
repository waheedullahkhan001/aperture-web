import { api, requireAuth } from './api.js';
import { esc, fmtDateTime, toast, confirmDialog, onSubmit, showApiError } from './ui.js';
import { icon } from './icons.js';
import qrcode from '../vendor/qrcode.mjs';
import './nav.js';

requireAuth();

const rows = document.querySelector('#rows');
const addDialog = document.querySelector('#add-dialog');
const tokenDialog = document.querySelector('#token-dialog');
const connectValue = document.querySelector('#connect-value');
const qrEl = document.querySelector('#qr');
let devices = [];

// base64url( utf8( JSON ) ) — RFC 4648 url-safe alphabet, padding stripped.
// Pinned exactly to the pairing spec so the Android app decodes it the same way.
function base64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The connect string the phone scans/pastes: { v, api, token }, base64url-encoded.
// `api` = the origin the Android app should talk to. On the deployed site that's this
// page's own origin (same-origin as the API); an explicit apiBase override wins for
// pointing a real phone at a specific backend during testing.
function connectString(token) {
  const api = localStorage.getItem('aperture.apiBase') || location.origin;
  return base64url(JSON.stringify({ v: 1, api, token }));
}

async function load() {
  try {
    devices = await api.get('/api/v1/me/devices');
    rows.innerHTML = devices.length ? devices.map((d) => `
      <tr>
        <td>${esc(d.name)}</td>
        <td>${fmtDateTime(d.createdAt)}</td>
        <td>${fmtDateTime(d.lastSeenAt)}</td>
        <td>${d.revoked
          ? `<span class="badge badge-ghost gap-1">${icon('circle-x', 'size-3')}revoked</span>`
          : `<span class="badge badge-success gap-1">${icon('circle-check', 'size-3')}active</span>`}</td>
        <td class="text-right">
          ${d.revoked ? '' : `<button class="btn btn-sm btn-error btn-outline gap-1" data-revoke="${d.id}">${icon('ban')}Revoke</button>`}
        </td>
      </tr>`).join('')
      : `<tr><td colspan="5" class="p-10">
          <div class="flex flex-col items-center gap-2 opacity-60">${icon('smartphone', 'size-10')}
            <span>No devices paired yet.</span>
          </div></td></tr>`;
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="5" class="text-center p-6 text-error">Failed to load devices.</td></tr>';
    showApiError(err);
  }
}

document.querySelector('#add').addEventListener('click', () => {
  document.querySelector('#add-form').reset();
  addDialog.showModal();
});

onSubmit(document.querySelector('#add-form'), async (fd) => {
  const created = await api.post('/api/v1/me/devices', { name: fd.get('name') });
  addDialog.close();
  const code = connectString(created.token);
  connectValue.value = code;
  const qr = qrcode(0, 'M'); // type 0 = auto-size, ECC level M
  qr.addData(code);
  qr.make();
  qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16 });
  tokenDialog.showModal();
  load();
});

document.querySelector('#copy-connect').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(connectValue.value);
    toast('Connect code copied to clipboard', 'success');
  } catch {
    // Clipboard can be blocked (permissions, insecure context) — never fail silently
    // on a shown-once secret. Select the text so a manual copy still works.
    connectValue.select();
    toast('Could not copy automatically — code selected, press Ctrl+C', 'warning');
  }
});

// The connect code embeds the one-time token and can't be retrieved again: block ESC so
// it's dismissed only via Done, and wipe both the code and the QR from the DOM on close.
tokenDialog.addEventListener('cancel', (e) => e.preventDefault());
tokenDialog.addEventListener('close', () => { connectValue.value = ''; qrEl.innerHTML = ''; });

rows.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-revoke]');
  if (!btn) return;
  const id = btn.dataset.revoke;
  const name = devices.find((d) => d.id === id)?.name ?? 'this device';
  if (!await confirmDialog(`Revoke "${name}"? The device will be signed out immediately and must be paired again to resume streaming.`, 'Revoke')) return;
  try {
    await api.del(`/api/v1/me/devices/${id}`);
    toast('Device revoked', 'success');
    load();
  } catch (err) {
    showApiError(err);
  }
});

// Close buttons for both dialogs.
document.querySelectorAll('dialog [data-close]').forEach((btn) =>
  btn.addEventListener('click', () => btn.closest('dialog').close()));

load();
