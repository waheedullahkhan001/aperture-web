import { api, requireAuth } from './api.js';
import { esc, fmtDateTime, toast, confirmDialog, onSubmit, showApiError } from './ui.js';
import './nav.js';

requireAuth();

const rows = document.querySelector('#rows');
const addDialog = document.querySelector('#add-dialog');
const tokenDialog = document.querySelector('#token-dialog');
const tokenValue = document.querySelector('#token-value');
let devices = [];

async function load() {
  try {
    devices = await api.get('/api/v1/me/devices');
    rows.innerHTML = devices.length ? devices.map((d) => `
      <tr>
        <td>${esc(d.name)}</td>
        <td>${fmtDateTime(d.createdAt)}</td>
        <td>${fmtDateTime(d.lastSeenAt)}</td>
        <td>${d.revoked
          ? '<span class="badge badge-ghost">revoked</span>'
          : '<span class="badge badge-success">active</span>'}</td>
        <td class="text-right">
          ${d.revoked ? '' : `<button class="btn btn-sm btn-error btn-outline" data-revoke="${d.id}">Revoke</button>`}
        </td>
      </tr>`).join('')
      : '<tr><td colspan="5" class="text-center p-6 opacity-70">No devices paired yet.</td></tr>';
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
  tokenValue.value = created.token;
  tokenDialog.showModal();
  load();
});

document.querySelector('#copy-token').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(tokenValue.value);
    toast('Token copied to clipboard', 'success');
  } catch {
    // Clipboard can be blocked (permissions, insecure context) — never fail silently
    // on a shown-once secret. Select the text so a manual copy still works.
    tokenValue.select();
    toast('Could not copy automatically — token selected, press Ctrl+C', 'warning');
  }
});

// The token cannot be retrieved again: block ESC so it can only be dismissed via
// the Done button, and wipe the plaintext from the DOM once the dialog closes.
tokenDialog.addEventListener('cancel', (e) => e.preventDefault());
tokenDialog.addEventListener('close', () => { tokenValue.value = ''; });

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
