import { api, requireAuth } from './api.js';
import { esc, fmtDateTime, fmtBytes, toast, confirmDialog, showApiError } from './ui.js';
import './nav.js';

requireAuth();

const id = new URLSearchParams(location.search).get('id');
if (!id) location.replace('recordings.html');

const STATUS_BADGE = {
  PENDING: 'badge-warning',
  RECORDING: 'badge-error animate-pulse',
  ENDED: 'badge-ghost',
  FAILED: 'badge-error badge-outline',
};

const info = document.querySelector('#info');
const segmentsEl = document.querySelector('#segments');
const samplesEl = document.querySelector('#samples');
const playerCard = document.querySelector('#player-card');
const player = document.querySelector('#player');
const playerTitle = document.querySelector('#player-title');
let currentBlobUrl = null;

async function load() {
  try {
    const { recording, segments, recentSamples } = await api.get(`/api/v1/recordings/${id}`);

    info.innerHTML = `
      <div class="flex items-center gap-3 flex-wrap">
        <h1 class="card-title text-xl">Recording</h1>
        <span class="badge ${STATUS_BADGE[recording.status] ?? ''}">${esc(recording.status)}</span>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 text-sm mt-2">
        <p><span class="opacity-70">Started:</span> ${fmtDateTime(recording.startedAt)}</p>
        <p><span class="opacity-70">Ended:</span> ${fmtDateTime(recording.endedAt)}</p>
        <p><span class="opacity-70">Alert countdown ends:</span> ${fmtDateTime(recording.countdownEndsAt)}</p>
        <p><span class="opacity-70">Alerts sent:</span> ${fmtDateTime(recording.alertsDispatchedAt)}</p>
        <p class="sm:col-span-2"><span class="opacity-70">ID:</span> <code class="text-xs">${esc(recording.id)}</code></p>
      </div>`;

    segmentsEl.innerHTML = segments.length ? segments.map((s) => `
      <tr>
        <td>${s.segmentNumber}</td>
        <td>${fmtDateTime(s.startTime)}</td>
        <td>${fmtDateTime(s.endTime)}</td>
        <td>${fmtBytes(s.sizeBytes)}</td>
        <td class="text-right whitespace-nowrap">
          <button class="btn btn-sm" data-play="${s.segmentNumber}">Play</button>
          <button class="btn btn-sm btn-outline" data-download="${s.segmentNumber}">Download</button>
        </td>
      </tr>`).join('')
      : '<tr><td colspan="5" class="text-center p-6 opacity-70">No video segments stored on the server yet.</td></tr>';

    samplesEl.innerHTML = recentSamples.length ? recentSamples.map((m) => `
      <tr>
        <td>${fmtDateTime(m.clientTimestamp)}</td>
        <td>${m.latitude ?? '—'}</td>
        <td>${m.longitude ?? '—'}</td>
        <td>${esc(m.deviceInfo ?? '—')}</td>
        <td>${m.latitude != null && m.longitude != null
          ? `<a class="link" target="_blank" rel="noopener"
               href="https://www.openstreetmap.org/?mlat=${m.latitude}&mlon=${m.longitude}#map=16/${m.latitude}/${m.longitude}">Open map</a>`
          : '—'}</td>
      </tr>`).join('')
      : '<tr><td colspan="5" class="text-center p-6 opacity-70">No location samples.</td></tr>';
  } catch (err) {
    showApiError(err);
  }
}

// Segment downloads are protected by the JWT, and <video src> / <a href> cannot send
// an Authorization header — so we fetch the bytes ourselves and use an object URL.
async function segmentUrl(n) {
  return api.blobUrl(`/api/v1/recordings/${id}/segments/${n}/download`);
}

document.querySelector('main').addEventListener('click', async (e) => {
  const playBtn = e.target.closest('[data-play]');
  const dlBtn = e.target.closest('[data-download]');
  try {
    if (playBtn) {
      const n = playBtn.dataset.play;
      playBtn.classList.add('btn-disabled');
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = await segmentUrl(n);
      playerTitle.textContent = `Playback — segment ${n}`;
      playerCard.classList.remove('hidden');
      player.src = currentBlobUrl;
      player.play();
      playBtn.classList.remove('btn-disabled');
      playerCard.scrollIntoView({ behavior: 'smooth' });
    } else if (dlBtn) {
      const n = dlBtn.dataset.download;
      dlBtn.classList.add('btn-disabled');
      const url = await segmentUrl(n);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recording-${id}-segment-${n}.mp4`;
      document.body.appendChild(a); // detached-anchor clicks are unreliable in some browsers
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000); // give the download time to start
      dlBtn.classList.remove('btn-disabled');
    }
  } catch (err) {
    playBtn?.classList.remove('btn-disabled');
    dlBtn?.classList.remove('btn-disabled');
    showApiError(err);
  }
});

document.querySelector('#delete').addEventListener('click', async () => {
  if (!await confirmDialog('Delete this recording and all its video files from the server? This cannot be undone.', 'Delete')) return;
  try {
    await api.del(`/api/v1/recordings/${id}`);
    toast('Recording deleted', 'success');
    location.replace('recordings.html');
  } catch (err) {
    showApiError(err);
  }
});

load();
