import { api, requireAuth } from './api.js';
import { esc, fmtDateTime, fmtBytes, toast, confirmDialog, showApiError, STATUS_BADGE } from './ui.js';
import './nav.js';

requireAuth();

const id = new URLSearchParams(location.search).get('id');
if (!id) location.replace('recordings.html');

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

    samplesEl.innerHTML = recentSamples.length ? recentSamples.map((m) => {
      // Coerce coordinates to real numbers — they feed an href, so never trust raw values.
      const lat = parseFloat(m.latitude);
      const lon = parseFloat(m.longitude);
      const hasCoords = !Number.isNaN(lat) && !Number.isNaN(lon);
      return `
      <tr>
        <td>${fmtDateTime(m.clientTimestamp)}</td>
        <td>${hasCoords ? lat : '—'}</td>
        <td>${hasCoords ? lon : '—'}</td>
        <td>${esc(m.deviceInfo ?? '—')}</td>
        <td>${hasCoords
          ? `<a class="link" target="_blank" rel="noopener"
               href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}">Open map</a>`
          : '—'}</td>
      </tr>`;
    }).join('')
      : '<tr><td colspan="5" class="text-center p-6 opacity-70">No location samples.</td></tr>';
  } catch (err) {
    info.innerHTML = `<p class="text-error">${err.status === 404 ? 'Recording not found.' : 'Failed to load this recording.'}
      <a class="link" href="recordings.html">Back to recordings</a></p>`;
    if (err.status !== 404) showApiError(err); // the card already explains a 404 fully
  }
}

// Segment downloads are protected by the JWT, and <video src> / <a href> cannot send
// an Authorization header — so we fetch the bytes ourselves and use an object URL.
async function segmentUrl(n) {
  return api.blobUrl(`/api/v1/recordings/${id}/segments/${n}/download`);
}

let busy = false; // one segment fetch at a time keeps memory bounded and blocks double-clicks

document.querySelector('main').addEventListener('click', async (e) => {
  const playBtn = e.target.closest('[data-play]');
  const dlBtn = e.target.closest('[data-download]');
  const btn = playBtn ?? dlBtn;
  if (!btn || busy) return;
  busy = true;
  const original = btn.textContent;
  btn.textContent = 'Loading…';
  btn.setAttribute('disabled', '');
  try {
    if (playBtn) {
      const n = playBtn.dataset.play;
      const newUrl = await segmentUrl(n);
      playerTitle.textContent = `Playback — segment ${n}`;
      playerCard.classList.remove('hidden');
      player.src = newUrl;
      player.play();
      // Revoke the previous URL only after the player switched to the new one.
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = newUrl;
      playerCard.scrollIntoView({ behavior: 'smooth' });
    } else {
      const n = dlBtn.dataset.download;
      const url = await segmentUrl(n);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recording-${id}-segment-${n}.mp4`;
      document.body.appendChild(a); // detached-anchor clicks are unreliable in some browsers
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000); // give the download time to start
    }
  } catch (err) {
    showApiError(err);
  } finally {
    btn.textContent = original;
    btn.removeAttribute('disabled');
    busy = false;
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
