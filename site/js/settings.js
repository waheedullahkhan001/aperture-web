import { api, requireAuth, logout, tokens, currentSessionId } from './api.js';
import { esc, fmtDateTime, toast, confirmDialog, onSubmit, showApiError } from './ui.js';
import './nav.js';

requireAuth();

const profileForm = document.querySelector('#profile-form');
const sessionsEl = document.querySelector('#sessions');

async function loadProfile() {
  try {
    const me = await api.get('/api/v1/me');
    document.querySelector('#email').value = me.email;
    profileForm.elements.fullname.value = me.fullname;
  } catch (err) {
    profileForm.inert = true; // never let a half-loaded form overwrite the real profile
    showApiError(err);
  }
}

onSubmit(profileForm, async (fd) => {
  await api.patch('/api/v1/me', { fullname: fd.get('fullname') });
  toast('Profile saved', 'success');
});

async function loadSessions() {
  try {
    const sessions = await api.get('/api/v1/me/sessions');
    const mine = currentSessionId();
    sessionsEl.innerHTML = sessions.map((s) => `
      <tr>
        <td class="max-w-xs truncate">${esc(s.label)}
          ${s.id === mine ? '<span class="badge badge-info badge-sm ml-1">this session</span>' : ''}</td>
        <td>${fmtDateTime(s.issuedAt)}</td>
        <td>${fmtDateTime(s.lastUsedAt)}</td>
        <td>${fmtDateTime(s.expiresAt)}</td>
        <td class="text-right">
          <button class="btn btn-sm btn-error btn-outline" data-revoke="${s.id}">
            ${s.id === mine ? 'Log out' : 'Revoke'}</button>
        </td>
      </tr>`).join('');
  } catch (err) {
    sessionsEl.innerHTML = '<tr><td colspan="5" class="text-center p-6 text-error">Failed to load sessions.</td></tr>';
    showApiError(err);
  }
}

sessionsEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-revoke]');
  if (!btn) return;
  const id = btn.dataset.revoke;
  const isCurrent = id === currentSessionId();
  if (!await confirmDialog(isCurrent
    ? 'Log out this session?'
    : 'Revoke this session? That browser will be signed out.', isCurrent ? 'Log out' : 'Revoke')) return;
  try {
    if (isCurrent) { await logout(); return; }
    await api.del(`/api/v1/me/sessions/${id}`);
    toast('Session revoked', 'success');
    loadSessions();
  } catch (err) {
    showApiError(err);
  }
});

document.querySelector('#delete-account').addEventListener('click', async () => {
  if (!await confirmDialog(
    'Permanently delete your account and ALL data — profile, devices, contacts and every recording on the server? This cannot be undone.',
    'Delete my account')) return;
  try {
    await api.del('/api/v1/me');
    tokens.clear();
    location.replace('index.html');
  } catch (err) {
    showApiError(err);
  }
});

loadProfile();
loadSessions();
