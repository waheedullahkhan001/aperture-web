import { api } from './api.js';
import { esc, fmtDateTime } from './ui.js';
import { playWhep } from './whep.js';

// Accept both URL shapes:
//   production: /watch/<uuid>?t=<secret>   (Nginx rewrites to watch.html)
//   dev:        /watch.html?id=<uuid>&t=<secret>
function params() {
  const qs = new URLSearchParams(location.search);
  const m = location.pathname.match(/\/watch\/([0-9a-fA-F-]{36})/);
  return { id: m?.[1] ?? qs.get('id'), t: qs.get('t') };
}

const { id, t } = params();
const statusEl = document.querySelector('#status');
const ownerEl = document.querySelector('#owner');
const metaEl = document.querySelector('#meta');
const messageEl = document.querySelector('#message');
const player = document.querySelector('#player');

const STATUS_BADGE = {
  PENDING: 'badge-warning',
  RECORDING: 'badge-error animate-pulse',
  ENDED: 'badge-ghost',
  FAILED: 'badge-error badge-outline',
};

let pc = null;          // active WebRTC connection, if any
let playing = false;
let pollTimer = null;

function showMessage(text, type = 'info') {
  messageEl.innerHTML = `<div class="alert alert-${type}">${esc(text)}</div>`;
}

async function startPlayback(view) {
  if (playing) return;
  playing = true;
  try {
    pc = await playWhep(player, view.webrtcUrl);     // low latency, first choice
  } catch {
    playing = startHls(view.hlsUrl);                  // fallback: HLS (~5-10 s latency)
    if (!playing) showMessage('Live video could not be loaded. The stream may be unreachable from your network.', 'warning');
  }
}

function startHls(hlsUrl) {
  try {
    if (player.canPlayType('application/vnd.apple.mpegurl')) { // Safari plays HLS natively
      player.src = hlsUrl;
      return true;
    }
    if (window.Hls?.isSupported()) {
      const hls = new Hls();
      hls.loadSource(hlsUrl);
      hls.attachMedia(player);
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

function stopPlayback() {
  pc?.close();
  pc = null;
  player.srcObject = null;
  player.removeAttribute('src');
}

function render(view) {
  statusEl.className = `badge ${STATUS_BADGE[view.status] ?? 'badge-ghost'}`;
  statusEl.textContent = view.status;
  ownerEl.textContent = `Streamed by ${view.ownerName} — started ${fmtDateTime(view.startedAt)}`;

  const s = view.latestSample;
  metaEl.innerHTML = `
    <p><span class="opacity-70">Last location update:</span> ${s ? fmtDateTime(s.clientTimestamp) : '—'}</p>
    <p><span class="opacity-70">Device:</span> ${s?.deviceInfo ? esc(s.deviceInfo) : '—'}</p>
    <p><span class="opacity-70">Coordinates:</span> ${s && s.latitude != null ? `${s.latitude}, ${s.longitude}` : '—'}</p>
    <p>${s && s.latitude != null
      ? `<a class="link" target="_blank" rel="noopener"
           href="https://www.openstreetmap.org/?mlat=${s.latitude}&mlon=${s.longitude}#map=16/${s.latitude}/${s.longitude}">Open location on map</a>`
      : ''}</p>`;
}

async function refresh() {
  try {
    const view = await api.public.get(`/api/public/watch/${id}?t=${encodeURIComponent(t)}`);
    render(view);
    if (view.status === 'RECORDING') {
      messageEl.innerHTML = '';
      startPlayback(view);
    } else if (view.status === 'PENDING') {
      showMessage('Waiting for the stream to start…');
    } else { // ENDED or FAILED — terminal states
      stopPlayback();
      clearInterval(pollTimer);
      showMessage(view.status === 'ENDED'
        ? 'This stream has ended.'
        : 'This recording failed before completing.', 'warning');
    }
  } catch (err) {
    clearInterval(pollTimer);
    stopPlayback();
    document.querySelector('#player-wrap').classList.add('hidden');
    showMessage(err.status === 403
      ? 'This watch link is invalid.'
      : err.status === 404
        ? 'This recording no longer exists.'
        : `Could not load the stream: ${err.message}`, 'error');
  }
}

if (!id || !t) {
  document.querySelector('#player-wrap').classList.add('hidden');
  showMessage('This watch link is incomplete.', 'error');
} else {
  refresh();
  pollTimer = setInterval(refresh, 15000); // keep status + location fresh
}
