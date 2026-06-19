import { api } from './api.js';
import { API_BASE } from './config.js';
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
let clipMode = false;    // user is reviewing a recorded clip → suppress live auto-restart
let activeSeg = null;    // segmentNumber currently playing as a clip
let clipsKey = '';       // signature of the last-rendered clip set (avoids disruptive re-renders)
let lastView = null;     // most recent watch payload (used by the resume-live button)

const clipsWrap = document.querySelector('#clips-wrap');
const clipsEl = document.querySelector('#clips');
const resumeLiveBtn = document.querySelector('#resume-live');
const playerNote = document.querySelector('#player-note');

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

// Coerce anything to a finite number or null (these feed display + a CSS rotate).
const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const metaRow = (label, value) => `<p><span class="opacity-70">${label}:</span> ${value}</p>`;

function render(view) {
  statusEl.className = `badge gap-1 ${STATUS_BADGE[view.status] ?? 'badge-ghost'}`;
  statusEl.innerHTML = `${icon(STATUS_ICON[view.status] ?? 'info', 'size-3')}<span></span>`;
  statusEl.querySelector('span').textContent = view.status;
  ownerEl.textContent = `Streamed by ${view.ownerName} — started ${fmtDateTime(view.startedAt)}`;

  const s = view.latestSample;
  const lat = num(s?.latitude), lon = num(s?.longitude);
  const hasCoords = lat != null && lon != null;

  const rows = [
    metaRow('Last location update', s ? fmtDateTime(s.clientTimestamp) : '—'),
    metaRow('Device', s?.deviceInfo ? esc(s.deviceInfo) : '—'),
    metaRow('Coordinates', hasCoords ? `${lat}, ${lon}` : '—'),
  ];

  // Optional responder telemetry — render each only when the phone sent it.
  const acc = num(s?.horizontalAccuracyM);
  if (acc != null) rows.push(metaRow('Accuracy', `±${Math.round(acc)} m`));

  const spd = num(s?.speedMps);
  if (spd != null) rows.push(metaRow('Speed', `${(spd * 3.6).toFixed(1)} km/h`));

  const brg = num(s?.bearingDeg);
  if (brg != null) {
    const d = ((brg % 360) + 360) % 360;
    const arrow = `<span class="inline-block" style="transform:rotate(${d}deg)">${icon('navigation', 'size-3')}</span>`;
    rows.push(metaRow('Heading', `<span class="inline-flex items-center gap-1">${arrow}${COMPASS[Math.round(d / 45) % 8]} (${Math.round(d)}°)</span>`));
  }

  const alt = num(s?.altitudeM);
  if (alt != null) rows.push(metaRow('Altitude', `${Math.round(alt)} m`));

  const bat = num(s?.batteryPercent);
  if (bat != null) {
    const lvl = Math.max(0, Math.min(100, Math.round(bat)));
    rows.push(metaRow('Battery', `<span class="inline-flex items-center gap-1 ${lvl <= 20 ? 'text-error' : ''}">${icon('battery', 'size-4')}${lvl}%</span>`));
  }

  rows.push(`<p class="sm:col-span-2">${hasCoords
    ? `<a class="link inline-flex items-center gap-1" target="_blank" rel="noopener"
         href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}">${icon('map-pin')}Open location on map</a>`
    : ''}</p>`);

  metaEl.innerHTML = rows.join('');
}

const fmtClock = (iso) => { try { return new Date(iso).toLocaleTimeString(); } catch { return '—'; } };

function fmtDuration(start, end) {
  const ms = new Date(end) - new Date(start);
  if (!(ms > 0)) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// Render the recorded-clip list. Backend returns segments in segmentNumber order, which
// isn't chronological once retro-uploaded (offline) clips are mixed in — so sort by
// startTime. Guarded by clipsKey so an unchanged set doesn't disrupt the current selection.
function renderClips(view) {
  const segs = (view.segments || []).slice().sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  if (!segs.length) { clipsWrap.classList.add('hidden'); clipsEl.innerHTML = ''; clipsKey = ''; return; }
  const key = segs.map((s) => `${s.segmentNumber}:${s.startTime}`).join('|');
  if (key === clipsKey) return;
  clipsKey = key;
  clipsWrap.classList.remove('hidden');
  clipsEl.innerHTML = segs.map((s) => {
    const up = s.source === 'UPLOADED';
    const dur = fmtDuration(s.startTime, s.endTime);
    return `<li><button type="button" data-seg="${esc(String(s.segmentNumber))}"
      class="btn btn-sm btn-block justify-start gap-2 ${s.segmentNumber === activeSeg ? 'btn-active' : ''}">
      ${icon(up ? 'upload' : 'film', 'size-4')}
      <span class="font-mono text-xs">${esc(fmtClock(s.startTime))} – ${esc(fmtClock(s.endTime))}</span>
      ${dur ? `<span class="opacity-60 text-xs">${dur}</span>` : ''}
      ${up ? '<span class="badge badge-ghost badge-xs ml-auto">uploaded</span>' : ''}
    </button></li>`;
  }).join('');
}

// Play one recorded clip inline (token-authed mp4, same-origin so ?t= works — no cookie).
function playClip(n) {
  clipMode = true;
  activeSeg = Number(n);
  stopPlayback();             // tear down any live WHEP/HLS first
  playerNote.classList.add('hidden');
  player.muted = false;       // user-initiated playback → sound on
  player.src = `${API_BASE}/api/public/watch/${id}/segments/${encodeURIComponent(n)}?t=${encodeURIComponent(t)}`;
  player.play().catch(() => {});
  clipsEl.querySelectorAll('[data-seg]').forEach((b) => b.classList.toggle('btn-active', b.dataset.seg === String(n)));
  resumeLiveBtn.classList.toggle('hidden', lastView?.status !== 'RECORDING');
}

let refreshing = false; // a poll tick can outlast the interval on slow networks

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const view = await api.public.get(`/api/public/watch/${id}?t=${encodeURIComponent(t)}`);
    lastView = view;
    render(view);
    renderClips(view);
    const live = view.status === 'RECORDING';
    resumeLiveBtn.classList.toggle('hidden', !(clipMode && live));
    // Polling continues even after the stream ends — retro-uploaded clips can arrive
    // later and should appear without a manual refresh. Only 403/404 stops it (below).
    if (clipMode) {
      // Reviewing a recorded clip — leave its playback and the message untouched.
    } else if (live) {
      messageEl.innerHTML = '';
      playerNote.classList.remove('hidden');
      startPlayback(view);
    } else if (view.status === 'PENDING') {
      playerNote.classList.remove('hidden');
      showMessage('Waiting for the stream to start…');
    } else { // ENDED or FAILED — clips become the playback path
      stopPlayback();
      playerNote.classList.add('hidden');
      const n = (view.segments || []).length;
      if (view.status === 'ENDED') {
        showMessage(n ? `Stream ended — ${n} clip${n > 1 ? 's' : ''} below to review.` : 'This stream has ended; no clips were saved.', n ? 'info' : 'warning');
      } else {
        showMessage(n ? `Recording failed — ${n} clip${n > 1 ? 's' : ''} below to review.` : 'This recording failed before completing.', 'warning');
      }
    }
  } catch (err) {
    if (err.status === 403 || err.status === 404) { // genuinely terminal — stop for good
      clearInterval(pollTimer);
      stopPlayback();
      document.querySelector('#player-wrap').classList.add('hidden');
      clipsWrap.classList.add('hidden');
      showMessage(err.status === 403 ? 'This watch link is invalid.' : 'This recording no longer exists.', 'error');
    } else if (!playing && !clipMode) {
      // Transient (network blip, server restart): keep polling — this page must
      // survive flaky mobile connections during an emergency. If video is already
      // playing, stay quiet; the stream itself is the signal that matters.
      showMessage('Connection problem — retrying…', 'warning');
    }
  } finally {
    refreshing = false;
  }
}

clipsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-seg]');
  if (b) playClip(b.dataset.seg);
});

resumeLiveBtn.addEventListener('click', () => {
  clipMode = false;
  activeSeg = null;
  resumeLiveBtn.classList.add('hidden');
  clipsEl.querySelectorAll('.btn-active').forEach((b) => b.classList.remove('btn-active'));
  player.pause();
  player.removeAttribute('src');
  player.muted = true; // re-mute so autoplay is allowed when live resumes
  if (lastView?.status === 'RECORDING') { playing = false; startPlayback(lastView); }
});

if (!id || !t) {
  document.querySelector('#player-wrap').classList.add('hidden');
  showMessage('This watch link is incomplete.', 'error');
} else {
  refresh();
  // 5 s so a moving responder's location/telemetry feels live once the phone streams
  // periodic samples; also picks up retro-uploaded clips after the stream ends.
  pollTimer = setInterval(refresh, 5000);
}
