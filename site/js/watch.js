import { api } from './api.js';
import { API_BASE } from './config.js';
import { esc, fmtDateTime, STATUS_BADGE, STATUS_ICON } from './ui.js';
import { icon } from './icons.js';
// NOTE: live playback is HLS-only. WebRTC/WHEP media is not plumbed server-side (only the
// signalling proxy exists), so WHEP half-negotiates and the video spins forever — see
// whep.js, ready to re-enable as a low-latency path once the server provides WebRTC media.

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

let hlsInstance = null;  // active hls.js instance, if any
let playing = false;
let pollTimer = null;
let stopped = false;     // set on 403/404 — the link is dead, stop polling for good
let clipMode = false;    // user is reviewing a recorded clip → suppress live auto-restart
let activeSeg = null;    // segmentNumber currently playing as a clip
let clipsKey = '';       // signature of the last-rendered clip set (avoids disruptive re-renders)
let lastView = null;     // most recent watch payload (used by the resume-live button)
let prevStatus = null;   // to detect status transitions (e.g. RECORDING → ENDED)
let recordedTried = false; // loaded the ENDED recorded timeline once
let hasTimeline = false; // ENDED recording has continuous streamed footage to scrub
let currentSpan = null;  // the recorded span loaded (for the "Full recording" button)
let playheadBaseMs = null; // wall-clock ms of the current VOD source's start (null for live)

const clipsWrap = document.querySelector('#clips-wrap');
const clipsEl = document.querySelector('#clips');
const resumeLiveBtn = document.querySelector('#resume-live');
const playerNote = document.querySelector('#player-note');
const playheadEl = document.querySelector('#playhead');

// Show the real-world time at the current playback position (footage start + offset), so a
// responder knows WHEN they're looking at. Only for recorded/clip playback — live is ~now.
function updatePlayhead() {
  if (playheadBaseMs == null || !Number.isFinite(player.currentTime)) { playheadEl.classList.add('hidden'); return; }
  playheadEl.textContent = `Footage time: ${new Date(playheadBaseMs + player.currentTime * 1000).toLocaleTimeString()}`;
  playheadEl.classList.remove('hidden');
}
player.addEventListener('timeupdate', updatePlayhead);
player.addEventListener('error', () => {
  // Direct-src (clip/recorded) load/decode failure — hls.js handles its own live errors,
  // and stopPlayback() clears src so its spurious error is ignored via the src guard.
  if (playheadBaseMs != null && player.getAttribute('src')) {
    showMessage('This recorded video could not be played.', 'error');
  }
});

function showMessage(text, type = 'info') {
  messageEl.innerHTML = `<div class="alert alert-${type}">${icon(MSG_ICON[type] ?? 'info', 'size-5 shrink-0')}<span>${esc(text)}</span></div>`;
}

function stopPlayback() {
  hlsInstance?.destroy();
  hlsInstance = null;
  player.srcObject = null;
  player.removeAttribute('src');
  playing = false;        // lets the next poll start playback again
  playheadBaseMs = null;  // no VOD source → hide the footage-time readout
  playheadEl.classList.add('hidden');
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

function startPlayback(view) {
  if (playing) return;
  playheadBaseMs = null; // live has no fixed footage time
  // HLS only — same-origin so the hlsSession cookie flows; MediaMTX builds the muxer on
  // demand and the playlist carries the AAC audio track. (WHEP intentionally not used; see
  // the import note.) hls.js' fatal-error handler resets `playing` so the poll retries.
  playing = startHls(sameOriginPath(view.hlsUrl));
  if (!playing) showMessage('Live video could not be loaded. The stream may be unreachable from your network.', 'warning');
}

function startHls(hlsUrl) {
  if (!hlsUrl) return false;
  try {
    if (player.canPlayType('application/vnd.apple.mpegurl')) { // Safari plays HLS natively
      player.src = hlsUrl;
      player.play().catch(() => {}); // autoplay attr is unreliable for a JS-set source
      return true;
    }
    if (window.Hls?.isSupported()) {
      hlsInstance = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 3 }); // hug the live edge
      // CRITICAL: with a programmatically-attached source the <video autoplay> attribute does
      // NOT reliably start playback — must call play() once the manifest is parsed. This was
      // the "needs a refresh to play" bug (a refresh just happened to win the timing race).
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => player.play().catch(() => {}));
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

// MediaMTX recorded playback (STREAMED footage), proxied same-origin under /playback.
// Build the /playback/get URL ourselves — the list's `url` field has the wrong host and
// no token. path keeps a raw slash and `start` is the RFC 3339 value verbatim from
// /playback/list; this exact form is what the running stack accepts.
function playbackUrl(start, duration) {
  return `${API_BASE}/playback/get?path=aperture/${id}&start=${start}&duration=${duration}&format=mp4&t=${encodeURIComponent(t)}`;
}
const durationSecs = (start, end) => Math.max(1, Math.round((new Date(end) - new Date(start)) / 1000));

async function loadSpans() {
  try {
    const spans = await api.public.get(`/playback/list?path=aperture/${id}&t=${encodeURIComponent(t)}`);
    return Array.isArray(spans) ? spans : [];
  } catch { return []; } // 404 "no recording segments found" → no continuous timeline
}

// Load a continuous recorded span as the scrubbable main video (native <video>, with the
// correct duration + faststart from MediaMTX). currentSpan lets "Full recording" return.
function loadRecordedSpan(span) {
  currentSpan = span;
  clipMode = false;
  activeSeg = null;
  stopPlayback();
  clipsEl.querySelectorAll('.btn-active').forEach((b) => b.classList.remove('btn-active'));
  playerNote.classList.add('hidden');
  player.muted = false;
  playheadBaseMs = Date.parse(span.start); // footage-time readout base
  player.src = playbackUrl(span.start, span.duration);
  player.load();
  player.play().catch(() => {}); // autoplay may be blocked — controls are there
  showReturnButton(null); // this IS the default view for an ended recording
}

// Contextual "return to the default source" button: back to LIVE during a recording, or
// back to the FULL RECORDING timeline after it ended. Hidden when already on the default.
function showReturnButton(kind) { // 'live' | 'timeline' | null
  if (!kind) { resumeLiveBtn.classList.add('hidden'); return; }
  resumeLiveBtn.classList.remove('hidden');
  resumeLiveBtn.innerHTML = kind === 'live'
    ? `${icon('radio', 'size-4')}Resume live`
    : `${icon('film', 'size-4')}Full recording`;
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
      <span class="badge badge-xs ml-auto ${up ? 'badge-ghost' : 'badge-info'}">${up ? 'uploaded' : 'live'}</span>
    </button></li>`;
  }).join('');
}

// Play one clip standalone. STREAMED clips go through MediaMTX playback/get (continuous,
// correct duration — fixes the old raw-fragment 0:04 bug); UPLOADED clips are already
// standalone MP4s on the API. Same-origin so the ?t= secret authorises without a cookie.
function playClip(n) {
  const seg = (lastView?.segments || []).find((s) => String(s.segmentNumber) === String(n));
  if (!seg) return;
  clipMode = true;
  activeSeg = Number(n);
  stopPlayback();
  playerNote.classList.add('hidden');
  player.muted = false; // user-initiated playback → sound on
  playheadBaseMs = Date.parse(seg.startTime); // footage-time readout base
  player.src = seg.source === 'UPLOADED'
    ? `${API_BASE}/api/public/watch/${id}/segments/${encodeURIComponent(n)}?t=${encodeURIComponent(t)}`
    : playbackUrl(seg.startTime, durationSecs(seg.startTime, seg.endTime));
  player.play().catch(() => {});
  clipsEl.querySelectorAll('[data-seg]').forEach((b) => b.classList.toggle('btn-active', b.dataset.seg === String(n)));
  // Offer a way back: to live during a recording, to the full recording after it ended.
  showReturnButton(lastView?.status === 'RECORDING' ? 'live' : (hasTimeline ? 'timeline' : null));
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

    // On the live→ended transition, drop a stale clip/live view so the ended branch loads
    // the recorded timeline fresh.
    if (view.status !== prevStatus) {
      if ((view.status === 'ENDED' || view.status === 'FAILED') && (prevStatus === 'RECORDING' || prevStatus === 'PENDING')) {
        clipMode = false; activeSeg = null; recordedTried = false;
      }
      prevStatus = view.status;
    }

    const live = view.status === 'RECORDING';
    // Polling continues even after the stream ends — retro-uploaded clips can arrive
    // later and should appear without a manual refresh. Only 403/404 stops it (below).
    if (clipMode) {
      // Reviewing a specific clip — leave its playback, message and return button untouched.
    } else if (live) {
      messageEl.innerHTML = '';
      playerNote.classList.remove('hidden');
      showReturnButton(null);
      startPlayback(view);
    } else if (view.status === 'PENDING') {
      playerNote.classList.remove('hidden');
      showReturnButton(null);
      showMessage('Waiting for the stream to start…');
    } else if (!recordedTried) { // ENDED or FAILED — load the recorded timeline once
      recordedTried = true;
      playerNote.classList.add('hidden');
      const spans = view.status === 'ENDED' ? await loadSpans() : [];
      hasTimeline = spans.length > 0;
      if (hasTimeline) loadRecordedSpan(spans[0]); // scrubbable continuous recording
      else { stopPlayback(); showReturnButton(null); }
      const n = (view.segments || []).length;
      let msg; let type = 'info';
      if (view.status === 'ENDED') {
        if (hasTimeline) msg = 'Stream ended — showing the recording. Scrub the timeline, or pick a clip below.';
        else if (n) msg = `Stream ended — ${n} clip${n > 1 ? 's' : ''} below to review.`;
        else { msg = 'This stream has ended; no recording was saved.'; type = 'warning'; }
      } else {
        msg = n ? `Recording failed — ${n} clip${n > 1 ? 's' : ''} below to review.` : 'This recording failed before completing.';
        type = 'warning';
      }
      showMessage(msg, type);
    }
  } catch (err) {
    if (err.status === 403 || err.status === 404) { // genuinely terminal — stop for good
      stopped = true;
      clearTimeout(pollTimer);
      stopPlayback();
      document.querySelector('#player-wrap').classList.add('hidden');
      clipsWrap.classList.add('hidden');
      resumeLiveBtn.classList.add('hidden');
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
  if (lastView?.status === 'RECORDING') {
    clipMode = false;
    activeSeg = null;
    clipsEl.querySelectorAll('.btn-active').forEach((b) => b.classList.remove('btn-active'));
    showReturnButton(null);
    player.pause();
    player.removeAttribute('src');
    player.muted = true; // re-mute so autoplay is allowed when live resumes
    playing = false;
    startPlayback(lastView);
  } else if (currentSpan) {
    loadRecordedSpan(currentSpan); // back to the full recording (clears clip + hides button)
  } else {
    showReturnButton(null);
  }
});

// Adaptive poll: fast while the stream is live so a moving responder's location feels
// real-time; slow once it has ended (retro-uploaded gap clips arrive infrequently, often
// minutes later) to cut needless load. A self-scheduling timeout reads the latest status
// each tick; 403/404 sets `stopped` and ends the loop.
const POLL_LIVE_MS = 5000;
const POLL_ENDED_MS = 25000;

async function pollLoop() {
  await refresh();
  if (stopped) return;
  const ended = lastView && (lastView.status === 'ENDED' || lastView.status === 'FAILED');
  pollTimer = setTimeout(pollLoop, ended ? POLL_ENDED_MS : POLL_LIVE_MS);
}

if (!id || !t) {
  document.querySelector('#player-wrap').classList.add('hidden');
  showMessage('This watch link is incomplete.', 'error');
} else {
  pollLoop();
}
