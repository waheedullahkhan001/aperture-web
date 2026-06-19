import { api, requireAuth } from './api.js';
import { esc, fmtDateTime, fmtBytes, toast, confirmDialog, showApiError, STATUS_BADGE, STATUS_ICON } from './ui.js';
import { icon } from './icons.js';
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
let currentWatchUrl = null; // the shareable public watch URL (for the copy button)

async function load() {
  try {
    const { recording, segments, recentSamples, watchUrl, viewRevoked } = await api.get(`/api/v1/recordings/${id}`);
    currentWatchUrl = watchUrl || null;

    // Watch-link controls. The link is a capability URL (anyone holding it can view).
    // Owner can open it ("Watch live", routed via our own origin so it works in dev too),
    // share it ("Copy watch link" = the public absolute URL the emails use), or revoke it.
    // A revoked link is dead everywhere (public view, clips, live HLS all 403), so the
    // controls collapse to a single "revoked" badge.
    let linkControls = '';
    if (viewRevoked) {
      linkControls = `<span class="badge badge-ghost gap-1">${icon('ban', 'size-3')}Watch link revoked</span>`;
    } else if (watchUrl) {
      const t = new URL(watchUrl).searchParams.get('t');
      const live = (recording.status === 'PENDING' || recording.status === 'RECORDING') && t
        ? `<a class="btn btn-sm btn-error gap-1" target="_blank" rel="noopener"
             href="watch.html?id=${encodeURIComponent(recording.id)}&t=${encodeURIComponent(t)}">${icon('play')}Watch live</a>`
        : '';
      linkControls = `${live}
        <button type="button" class="btn btn-sm btn-outline gap-1" data-copy-link>${icon('copy')}Copy watch link</button>
        <button type="button" class="btn btn-sm btn-error btn-outline gap-1" data-revoke-link>${icon('ban')}Revoke watch link</button>`;
    }

    info.innerHTML = `
      <div class="flex items-center gap-3 flex-wrap">
        <h1 class="card-title text-xl">Recording</h1>
        <span class="badge gap-1 ${STATUS_BADGE[recording.status] ?? ''}">${icon(STATUS_ICON[recording.status] ?? 'info', 'size-3')}${esc(recording.status)}</span>
        ${linkControls}
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
          <button class="btn btn-sm gap-1" data-play="${s.segmentNumber}">${icon('play')}Play</button>
          <button class="btn btn-sm btn-outline gap-1" data-download="${s.segmentNumber}">${icon('download')}Download</button>
        </td>
      </tr>`).join('')
      : `<tr><td colspan="5" class="p-10"><div class="flex flex-col items-center gap-2 opacity-60">${icon('film', 'size-10')}<span>No video segments stored on the server yet.</span></div></td></tr>`;

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
          ? `<a class="link inline-flex items-center gap-1" target="_blank" rel="noopener"
               href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}">${icon('map-pin', 'size-3')}Open map</a>`
          : '—'}</td>
      </tr>`;
    }).join('')
      : `<tr><td colspan="5" class="p-10"><div class="flex flex-col items-center gap-2 opacity-60">${icon('map-pin', 'size-10')}<span>No location samples.</span></div></td></tr>`;
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
  // Copy the shareable public watch URL.
  if (e.target.closest('[data-copy-link]')) {
    if (!currentWatchUrl) return;
    try {
      await navigator.clipboard.writeText(currentWatchUrl);
      toast('Watch link copied to clipboard', 'success');
    } catch {
      toast('Could not copy automatically — open “Watch live” and copy from the address bar', 'warning');
    }
    return;
  }
  // Revoke the watch link — irreversible, kills the ?t= secret everywhere.
  if (e.target.closest('[data-revoke-link]')) {
    if (!await confirmDialog('Revoke this watch link? Anyone who already has it — including emergency contacts you have shared it with — immediately loses access to the live view, clips and playback. This cannot be undone.', 'Revoke link')) return;
    try {
      await api.post(`/api/v1/recordings/${id}/revoke-link`);
      toast('Watch link revoked', 'success');
      load(); // reflect viewRevoked
    } catch (err) {
      showApiError(err);
    }
    return;
  }

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
