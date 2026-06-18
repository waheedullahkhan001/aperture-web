import { api } from './api.js';
import { esc, fmtDateTime, STATUS_BADGE, STATUS_ICON } from './ui.js';
import { icon } from './icons.js';
import { playWhep } from './whep.js';

const MSG_ICON = { info: 'info', success: 'circle-check', warning: 'triangle-alert', error: 'circle-x' };

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

let pc = null;           // active WebRTC connection, if any
let hlsInstance = null;  // active hls.js instance, if any
let playing = false;
let pollTimer = null;

function showMessage(text, type = 'info') {
  messageEl.innerHTML = `<div class="alert alert-${type}">${icon(MSG_ICON[type] ?? 'info', 'size-5 shrink-0')}<span>${esc(text)}</span></div>`;
}

function stopPlayback() {
  pc?.close();
  pc = null;
  hlsInstance?.destroy();
  hlsInstance = null;
  player.srcObject = null;
  player.removeAttribute('src');
  playing = false; // lets the next poll start playback again
}

// The watch endpoint returns ABSOLUTE stream URLs (e.g. http://localhost/aperture/<id>/…).
// Resolve them against THIS page's origin (keep path + query, drop scheme/host) so the
// HttpOnly hlsSession cookie — which MediaMTX scopes to /aperture/<id>/ — is sent with
// every child playlist and segment request. Same-origin is the backend's stated contract;
// the /aperture/<id>/ path is preserved verbatim, and the ?t= secret is never re-injected.
function sameOriginPath(url) {
  try { const u = new URL(url, location.href); return u.pathname + u.search; }
  catch { return url; }
}

async function startPlayback(view) {
  if (playing) return;
  playing = true;
  const webrtcUrl = sameOriginPath(view.webrtcUrl);
  const hlsUrl = sameOriginPath(view.hlsUrl);
  try {
    pc = await playWhep(player, webrtcUrl); // low latency, first choice
    pc.addEventListener('connectionstatechange', (e) => {
      if (e.target !== pc) return; // stale event from a replaced connection
      const state = pc.connectionState;
      if (state === 'failed' || state === 'disconnected') {
        stopPlayback();
        showMessage('Stream connection lost — reconnecting…', 'warning');
      }
    });
  } catch {
    playing = startHls(hlsUrl); // fallback: HLS (~5-10 s latency)
    if (!playing) showMessage('Live video could not be loaded. The stream may be unreachable from your network.', 'warning');
  }
}

function startHls(hlsUrl) {
  if (!hlsUrl) return false;
  try {
    if (player.canPlayType('application/vnd.apple.mpegurl')) { // Safari plays HLS natively
      player.src = hlsUrl;
      return true;
    }
    if (window.Hls?.isSupported()) {
      hlsInstance = new Hls();
      hlsInstance.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          stopPlayback();
          showMessage('Stream connection lost — reconnecting…', 'warning');
        }
      });
      hlsInstance.loadSource(hlsUrl);
      hlsInstance.attachMedia(player);
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

function render(view) {
  statusEl.className = `badge gap-1 ${STATUS_BADGE[view.status] ?? 'badge-ghost'}`;
  statusEl.innerHTML = `${icon(STATUS_ICON[view.status] ?? 'info', 'size-3')}<span></span>`;
  statusEl.querySelector('span').textContent = view.status;
  ownerEl.textContent = `Streamed by ${view.ownerName} — started ${fmtDateTime(view.startedAt)}`;

  const s = view.latestSample;
  // Coerce coordinates to real numbers — they feed an href, so never trust raw values.
  const lat = s ? parseFloat(s.latitude) : NaN;
  const lon = s ? parseFloat(s.longitude) : NaN;
  const hasCoords = !Number.isNaN(lat) && !Number.isNaN(lon);
  metaEl.innerHTML = `
    <p><span class="opacity-70">Last location update:</span> ${s ? fmtDateTime(s.clientTimestamp) : '—'}</p>
    <p><span class="opacity-70">Device:</span> ${s?.deviceInfo ? esc(s.deviceInfo) : '—'}</p>
    <p><span class="opacity-70">Coordinates:</span> ${hasCoords ? `${lat}, ${lon}` : '—'}</p>
    <p>${hasCoords
      ? `<a class="link inline-flex items-center gap-1" target="_blank" rel="noopener"
           href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}">${icon('map-pin')}Open location on map</a>`
      : ''}</p>`;
}

let refreshing = false; // a poll tick can outlast the 15 s interval on slow networks

async function refresh() {
  if (refreshing) return;
  refreshing = true;
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
    if (err.status === 403 || err.status === 404) { // genuinely terminal — stop for good
      clearInterval(pollTimer);
      stopPlayback();
      document.querySelector('#player-wrap').classList.add('hidden');
      showMessage(err.status === 403 ? 'This watch link is invalid.' : 'This recording no longer exists.', 'error');
    } else if (!playing) {
      // Transient (network blip, server restart): keep polling — this page must
      // survive flaky mobile connections during an emergency. If video is already
      // playing, stay quiet; the stream itself is the signal that matters.
      showMessage('Connection problem — retrying…', 'warning');
    }
  } finally {
    refreshing = false;
  }
}

if (!id || !t) {
  document.querySelector('#player-wrap').classList.add('hidden');
  showMessage('This watch link is incomplete.', 'error');
} else {
  refresh();
  pollTimer = setInterval(refresh, 15000); // keep status + location fresh
}
