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
let endedHandled = false; // showed the "stream ended" message once
let playheadBaseMs = null; // wall-clock ms of the current clip's start (null for live)
let isLive = false;        // live HLS is the current source (drives the live footage-time)
let wantPlay = false;      // we intend to autoplay the current source — retry until it starts
let liveKicks = 0;         // cold-start restarts attempted for a stuck live stream
let watchdog = null;       // timer that restarts a live stream still stuck at 0:00

const clipsWrap = document.querySelector('#clips-wrap');
const clipsEl = document.querySelector('#clips');
const resumeLiveBtn = document.querySelector('#resume-live');
const playerNote = document.querySelector('#player-note');
const playheadEl = document.querySelector('#playhead');
const metaContextEl = document.querySelector('#meta-context');
const metaNoteEl = document.querySelector('#meta-note');

// Show the real-world time the on-screen footage was captured, so a responder knows WHEN
// they're looking at. Clips: known start + playback offset. Live: the current frame's
// program-date-time from hls.js (falls back to ~now if the playlist carries no PDT).
function updatePlayhead() {
  let wall = null;
  let prefix = 'Footage time';
  if (playheadBaseMs != null && Number.isFinite(player.currentTime)) {
    wall = playheadBaseMs + player.currentTime * 1000;
  } else if (isLive) {
    wall = hlsInstance?.playingDate?.getTime() ?? Date.now();
    prefix = 'Live';
  }
  if (wall == null) { playheadEl.classList.add('hidden'); return; }
  playheadEl.textContent = `${prefix}: ${new Date(wall).toLocaleTimeString()}`;
  playheadEl.classList.remove('hidden');
}

// While a clip plays, keep the telemetry panel in sync with the playback position (so the
// location shown is the location AT that moment). Throttled to once per wall-clock second.
let lastMetaSec = -1;
player.addEventListener('timeupdate', () => {
  updatePlayhead();
  if (!clipMode || playheadBaseMs == null) return;
  const sec = Math.floor((playheadBaseMs + player.currentTime * 1000) / 1000);
  if (sec !== lastMetaSec) { lastMetaSec = sec; renderMeta(); }
});

// Robust autoplay: a source becomes playable via different events depending on codec path
// and how warm the muxer is. Keep trying play() until it actually starts; once it does (or
// the user pauses) stop forcing it, so we never override a deliberate pause.
function attemptPlay() {
  if (!wantPlay) return;
  player.play().then(() => { wantPlay = false; }).catch(() => { /* retry on the next event */ });
}
player.addEventListener('canplay', attemptPlay);
player.addEventListener('loadeddata', attemptPlay);
player.addEventListener('playing', () => { wantPlay = false; liveKicks = 0; clearWatchdog(); });
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
  clearWatchdog();
  hlsInstance?.destroy();
  hlsInstance = null;
  player.srcObject = null;
  player.removeAttribute('src');
  playing = false;        // lets the next poll start playback again
  isLive = false;
  wantPlay = false;
  playheadBaseMs = null;  // no source → hide the footage-time readout
  playheadEl.classList.add('hidden');
}

function clearWatchdog() { clearTimeout(watchdog); watchdog = null; }

// Cold-start guard: MediaMTX builds the HLS muxer on first request, so the very first
// attempt can attach but never buffer (stuck at 0:00) — which is exactly the "had to
// refresh" bug. If live hasn't actually started after a few seconds, restart it ourselves
// (what a manual refresh does), escalating to standard HLS for reliability over latency.
function armWatchdog() {
  clearWatchdog();
  watchdog = setTimeout(() => {
    if (!isLive) return;
    if (!player.paused && player.currentTime > 0) { liveKicks = 0; return; } // healthy
    if (liveKicks >= 2) { showMessage('Live video is taking longer than usual to start…', 'warning'); return; }
    liveKicks += 1;
    const v = lastView;
    stopPlayback();
    if (v?.status === 'RECORDING') startPlayback(v, false); // retry without low-latency mode
  }, 6000);
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

function startPlayback(view, lowLatency = true) {
  if (playing) return;
  playheadBaseMs = null; // live has no fixed footage time
  // HLS only — same-origin so the hlsSession cookie flows; MediaMTX builds the muxer on
  // demand and the playlist carries the AAC audio track. (WHEP intentionally not used; see
  // the import note.)
  playing = startHls(sameOriginPath(view.hlsUrl), lowLatency);
  isLive = playing; // live source active → footage-time tracks the live frame's capture time
  if (playing) armWatchdog(); // recover a cold-muxer stall without a manual refresh
  else showMessage('Live video could not be loaded. The stream may be unreachable from your network.', 'warning');
}

function startHls(hlsUrl, lowLatency = true) {
  if (!hlsUrl) return false;
  wantPlay = true; // keep retrying play() until it actually starts
  try {
    if (player.canPlayType('application/vnd.apple.mpegurl')) { // Safari plays HLS natively
      player.src = hlsUrl;
      attemptPlay();
      return true;
    }
    if (window.Hls?.isSupported()) {
      // Low-latency hugs the live edge but is fragile on a cold muxer; the watchdog falls
      // back to standard HLS (lowLatency=false) if the first attempt stalls.
      hlsInstance = new Hls({ lowLatencyMode: lowLatency, liveSyncDurationCount: lowLatency ? 3 : 6 });
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, attemptPlay);
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
}

// Render the telemetry rows for ONE sample (dashes where there's no reading).
function renderSampleRows(s) {
  const lat = num(s?.latitude), lon = num(s?.longitude);
  const hasCoords = lat != null && lon != null;
  const rows = [
    metaRow('Device', s?.deviceInfo ? esc(s.deviceInfo) : '—'),
    metaRow('Coordinates', hasCoords ? `${lat}, ${lon}` : '—'),
  ];
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
  if (hasCoords) {
    rows.push(`<p class="sm:col-span-2"><a class="link inline-flex items-center gap-1" target="_blank" rel="noopener"
      href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}">${icon('map-pin')}Open location on map</a></p>`);
  }
  metaEl.innerHTML = rows.join('');
}

// Most recent sample at or before a wall-clock time — historical lookup for clip playback.
function sampleAt(view, atMs) {
  const arr = Array.isArray(view.samples) ? view.samples : [];
  let chosen = null, chosenTs = -Infinity;
  for (const s of arr) {
    const ts = Date.parse(s.clientTimestamp);
    if (ts <= atMs && ts > chosenTs) { chosen = s; chosenTs = ts; }
  }
  return chosen;
}

// Choose WHICH telemetry sample to show and label its time context in clear words: the live
// reading during a live stream, or the reading from the moment you're viewing inside a clip.
function renderMeta() {
  const view = lastView;
  if (!view) return;
  const hasHistory = Array.isArray(view.samples) && view.samples.length > 0;
  let sample, label, note = '', tone = 'badge-ghost';

  if (clipMode && playheadBaseMs != null) {
    const atMs = playheadBaseMs + (Number.isFinite(player.currentTime) ? player.currentTime * 1000 : 0);
    label = `Recorded · ${new Date(atMs).toLocaleTimeString()}`;
    if (hasHistory) {
      sample = sampleAt(view, atMs);
      note = sample ? 'Location and telemetry as they were at this point in the recording.'
                    : 'No telemetry was recorded at this moment.';
    } else {
      sample = view.latestSample; // interim: public API exposes only the latest reading
      note = 'Showing the latest known reading — moment-by-moment telemetry for past clips isn’t available yet.';
    }
  } else if (isLive) {
    sample = view.latestSample;
    tone = 'badge-info';
    label = sample ? `Live · updated ${new Date(Date.parse(sample.clientTimestamp)).toLocaleTimeString()}` : 'Live';
  } else {
    sample = view.latestSample;
    label = sample ? `Last known · ${new Date(Date.parse(sample.clientTimestamp)).toLocaleTimeString()}` : 'No telemetry yet';
  }

  metaContextEl.className = `badge badge-sm ${tone}`;
  metaContextEl.textContent = label;
  metaNoteEl.classList.toggle('hidden', !note);
  if (note) metaNoteEl.textContent = note;
  renderSampleRows(sample);
}

const fmtClock = (iso) => { try { return new Date(iso).toLocaleTimeString(); } catch { return '—'; } };

function fmtDuration(start, end) {
  const ms = new Date(end) - new Date(start);
  if (!(ms > 0)) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// The "Resume live" button — shown only while reviewing a clip during a live recording.
function showReturnButton(show) {
  if (!show) { resumeLiveBtn.classList.add('hidden'); return; }
  resumeLiveBtn.classList.remove('hidden');
  resumeLiveBtn.innerHTML = `${icon('radio', 'size-4')}Resume live`;
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
  clipsEl.innerHTML = segs.map((s, i) => {
    const up = s.source === 'UPLOADED';
    const dur = fmtDuration(s.startTime, s.endTime);
    return `<li><button type="button" data-seg="${esc(String(s.segmentNumber))}"
      class="btn btn-sm btn-block justify-start gap-2 ${s.segmentNumber === activeSeg ? 'btn-active' : ''}">
      <span class="font-mono text-xs opacity-50 w-5 text-right shrink-0">${i + 1}</span>
      ${icon(up ? 'upload' : 'film', 'size-4')}
      <span class="font-mono text-xs">${esc(fmtClock(s.startTime))} – ${esc(fmtClock(s.endTime))}</span>
      ${dur ? `<span class="opacity-60 text-xs">${dur}</span>` : ''}
      <span class="badge badge-xs ml-auto ${up ? 'badge-ghost' : 'badge-info'}">${up ? 'uploaded' : 'live'}</span>
    </button></li>`;
  }).join('');
}

// Play one clip. Both STREAMED and UPLOADED segments serve a browser-clean, Range-capable
// MP4 from the same endpoint (the backend normalises recorded segments), so it plays and
// seeks natively in <video src>. Same-origin so the ?t= secret authorises without a cookie.
function playClip(n) {
  const seg = (lastView?.segments || []).find((s) => String(s.segmentNumber) === String(n));
  if (!seg) return;
  clipMode = true;
  activeSeg = Number(n);
  stopPlayback();
  playerNote.classList.add('hidden');
  player.muted = false; // user-initiated playback → sound on
  playheadBaseMs = Date.parse(seg.startTime); // footage-time readout base
  player.src = `${API_BASE}/api/public/watch/${id}/segments/${encodeURIComponent(n)}?t=${encodeURIComponent(t)}`;
  wantPlay = true;
  attemptPlay();
  clipsEl.querySelectorAll('[data-seg]').forEach((b) => b.classList.toggle('btn-active', b.dataset.seg === String(n)));
  showReturnButton(lastView?.status === 'RECORDING'); // offer "Resume live" during a recording
  lastMetaSec = -1;
  renderMeta(); // telemetry for this clip's start moment, immediately
}

// When a clip ends, auto-advance to the next one (chronological) for a continuous watch.
player.addEventListener('ended', () => {
  if (!clipMode) return;
  const segs = (lastView?.segments || []).slice().sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const next = segs[segs.findIndex((s) => s.segmentNumber === activeSeg) + 1];
  if (next) playClip(next.segmentNumber);
});

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
    // Polling continues even after the stream ends — retro-uploaded clips can arrive
    // later and should appear without a manual refresh. Only 403/404 stops it (below).
    if (clipMode) {
      // Reviewing a clip — leave its playback, message and return button untouched.
    } else if (live) {
      endedHandled = false;
      messageEl.innerHTML = '';
      playerNote.classList.remove('hidden');
      showReturnButton(false);
      startPlayback(view);
    } else if (view.status === 'PENDING') {
      playerNote.classList.remove('hidden');
      showReturnButton(false);
      showMessage('Waiting for the stream to start…');
    } else if (!endedHandled) { // ENDED or FAILED — pure clips model, no live player
      endedHandled = true;
      stopPlayback();
      playerNote.classList.add('hidden');
      showReturnButton(false);
      const n = (view.segments || []).length;
      if (view.status === 'ENDED') {
        showMessage(n ? `Stream ended — ${n} clip${n > 1 ? 's' : ''} below to review.` : 'This stream has ended; no clips were saved.', n ? 'info' : 'warning');
      } else {
        showMessage(n ? `Recording failed — ${n} clip${n > 1 ? 's' : ''} below to review.` : 'This recording failed before completing.', 'warning');
      }
    }
    renderMeta(); // keep the telemetry panel + its time-context label current
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
  clipMode = false;
  activeSeg = null;
  clipsEl.querySelectorAll('.btn-active').forEach((b) => b.classList.remove('btn-active'));
  showReturnButton(false);
  stopPlayback();
  player.muted = true; // re-mute so autoplay is allowed when live resumes
  if (lastView?.status === 'RECORDING') startPlayback(lastView);
  renderMeta(); // back to live/last-known telemetry
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
