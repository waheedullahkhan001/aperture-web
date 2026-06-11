import { api, requireAuth } from './api.js';
import { esc, fmtDateTime, toast, confirmDialog, showApiError } from './ui.js';
import './nav.js';

requireAuth();

const STATUS_BADGE = {
  PENDING: 'badge-warning',
  RECORDING: 'badge-error animate-pulse',
  ENDED: 'badge-ghost',
  FAILED: 'badge-error badge-outline',
};

const rows = document.querySelector('#rows');
const pageInfo = document.querySelector('#page-info');
const filter = document.querySelector('#status-filter');
let page = 0;
let totalPages = 1;

async function load() {
  const params = new URLSearchParams({ page, size: 20 });
  if (filter.value) params.set('status', filter.value);
  try {
    const data = await api.get(`/api/v1/recordings?${params}`);
    totalPages = Math.max(data.totalPages, 1);
    // After deleting the last row of the last page we can be past the end — rewind.
    if (page >= totalPages && page > 0) {
      page = totalPages - 1;
      return load();
    }
    pageInfo.textContent = `Page ${data.page + 1} of ${totalPages} (${data.totalElements} total)`;
    if (!data.content.length) {
      rows.innerHTML = `<tr><td colspan="5" class="text-center p-6 opacity-70">
        No recordings yet. Recordings appear here when your device streams to the server.</td></tr>`;
      return;
    }
    rows.innerHTML = data.content.map((r) => `
      <tr>
        <td>${fmtDateTime(r.startedAt)}</td>
        <td>${fmtDateTime(r.endedAt)}</td>
        <td><span class="badge ${STATUS_BADGE[r.status] ?? ''}">${esc(r.status)}</span></td>
        <td>${r.alertsDispatchedAt ? fmtDateTime(r.alertsDispatchedAt) : '—'}</td>
        <td class="text-right whitespace-nowrap">
          <a class="btn btn-sm" href="recording.html?id=${r.id}">View</a>
          <button class="btn btn-sm btn-error btn-outline" data-delete="${r.id}">Delete</button>
        </td>
      </tr>`).join('');
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="5" class="text-center p-6 text-error">Failed to load recordings.</td></tr>';
    showApiError(err);
  }
}

rows.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete]');
  if (!btn) return;
  const id = btn.dataset.delete;
  if (!await confirmDialog('Delete this recording and all its video files from the server? This cannot be undone.', 'Delete')) return;
  try {
    await api.del(`/api/v1/recordings/${id}`);
    toast('Recording deleted', 'success');
    load();
  } catch (err) {
    showApiError(err);
  }
});

filter.addEventListener('change', () => { page = 0; load(); });
document.querySelector('#prev').addEventListener('click', () => { if (page > 0) { page--; load(); } });
document.querySelector('#next').addEventListener('click', () => { if (page < totalPages - 1) { page++; load(); } });

load();
