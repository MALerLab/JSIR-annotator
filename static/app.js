/* Jazz Beat & Section Annotator — frontend.
 *
 * Audio is decoded once into an AudioBuffer and played through an
 * AudioBufferSourceNode so playback, the playhead, and the metronome all ride
 * the same Web-Audio clock (sample-accurate, low latency).
 *
 * Performance model (important):
 *   - The canvas is sized to the VIEWPORT, not the whole timeline. A full-width
 *     spacer (#wave-stage) provides the scrollbar; the canvas layer is pinned
 *     to the left edge (position: sticky) and we redraw only the visible window
 *     on scroll. Cost per redraw is O(viewport px), independent of song length
 *     or zoom.
 *   - Waveform peaks (min/max per timeline pixel) are computed ONCE per zoom
 *     level and cached, so dragging / selecting / scrubbing never rescans the
 *     audio samples.
 *   - The moving playhead lives on a separate overlay canvas so it animates
 *     without repainting the waveform.
 */

// ----------------------------------------------------------------------------
// Constants & state
// ----------------------------------------------------------------------------
const RULER_H = 22;           // top scrub/timeline strip
const SECTION_LANE_H = 22;    // section-tab lane (below the ruler)
const CHORD_LANE_H = 22;      // chord lane (below sections, above the waveform)
const BEAT_HIT_PX = 5;        // click tolerance for selecting/dragging a beat
const LOOKAHEAD = 0.12;       // metronome scheduling lookahead (s)
const SCHED_MS = 25;          // metronome scheduler tick (ms)

const state = {
  songs: [],
  current: null,
  buffer: null,
  duration: 0,
  beats: [],            // [{t}] (kept sorted)
  sections: [],         // [{time, name}] (kept sorted)
  chords: [],           // [{time, chord}] (kept sorted)
  selected: null,       // {kind:'beat'|'section'|'chord', obj}
  pxPerSec: 60,
  totalW: 0,            // full timeline width in px (duration * pxPerSec)
  _vw: 0,               // viewport width (canvas css width)
  _h: 0,                // viewport height
  // transport
  playing: false,
  currentTime: 0,
  source: null,
  ctxStartTime: 0,
  startOffset: 0,
  nextBeatIdx: 0,
  schedTimer: null,
  raf: null,
  dirty: false,
};

let audioCtx = null;
function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

const $ = (id) => document.getElementById(id);
const waveCanvas = $('wave-canvas');
const overlayCanvas = $('overlay-canvas');
const waveScroll = $('wave-scroll');
const waveStage = $('wave-stage');
const waveSticky = $('wave-sticky');
const wctx = waveCanvas.getContext('2d');
const octx = overlayCanvas.getContext('2d');

// ----------------------------------------------------------------------------
// Song list
// ----------------------------------------------------------------------------
async function loadSongs() {
  const res = await fetch('/api/songs');
  state.songs = await res.json();
  renderSongList();
}

function renderSongList() {
  const ul = $('song-list');
  const filter = $('song-filter').value.toLowerCase();
  ul.innerHTML = '';
  state.songs
    .filter((s) =>
      [s.standard, s.artist, s.album, s.instrumentation]
        .filter(Boolean).join(' ').toLowerCase().includes(filter)
    )
    .forEach((s) => {
      const li = document.createElement('li');
      if (state.current && state.current.stem === s.stem) li.classList.add('active');
      const sub = [s.artist, s.instrumentation].filter(Boolean).join(' · ');
      li.innerHTML =
        `<div class="t">${escapeHtml(s.standard || '(untitled)')}` +
        (s.has_sections ? '<span class="dot" title="has saved sections">●</span>' : '') +
        `</div><div class="a">${escapeHtml(sub)}</div>`;
      li.onclick = () => selectSong(s);
      ul.appendChild(li);
    });
}

$('song-filter').addEventListener('input', renderSongList);

function renderSongMeta(song) {
  const fields = [
    ['Standard', song.standard],
    ['Artist', song.artist],
    ['Album', song.album],
    ['Instrumentation', song.instrumentation],
  ];
  let html = fields
    .filter(([, v]) => v)
    .map(([k, v]) => `<span class="meta-field"><b>${k}:</b> ${escapeHtml(v)}</span>`)
    .join('');
  if (song.yt_id) {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(song.yt_id)}`;
    html += `<a class="meta-yt" href="${url}" target="_blank" rel="noopener" ` +
            `title="Open source video">▶ YouTube (${escapeHtml(song.yt_id)})</a>`;
  }
  $('song-meta').innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

// ----------------------------------------------------------------------------
// Song selection / loading
// ----------------------------------------------------------------------------
async function selectSong(song) {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  stopPlayback();
  state.current = song;
  state.selected = null;
  state.dirty = false;
  state.currentTime = 0;
  renderSongList();
  setStatus('loading…');
  $('song-title').textContent = song.standard || '(untitled)';
  renderSongMeta(song);

  let annRes, buffer;
  try {
    const audioUrl = `/audio/${song.audio.replace(/^audio\//, '')}`;
    const [ann, audioResp] = await Promise.all([
      fetch(`/api/song/${song.stem}`).then((r) => r.json()),
      fetch(audioUrl),
    ]);
    if (!audioResp.ok) throw new Error(`audio HTTP ${audioResp.status}`);
    annRes = ann;
    buffer = await ctx().decodeAudioData(await audioResp.arrayBuffer());
  } catch (err) {
    // stale selection? ignore if the user moved on
    if (state.current !== song) return;
    state.buffer = null;
    enableControls(false);
    setStatus(`could not load audio (${err.message})`);
    return;
  }
  if (state.current !== song) return; // a newer selection won the race

  state.beats = annRes.beats.map((t) => ({ t }));
  state.sections = annRes.sections.map((s) => ({ time: s.time, name: s.name }));
  state.chords = (annRes.chords || []).map((c) => ({ time: c.time, chord: c.chord }));
  state.buffer = buffer;
  state.duration = state.buffer.duration;

  fitZoom();
  enableControls(true);
  waveScroll.scrollLeft = 0;
  layoutCanvas();
  renderStatic();
  drawPlayhead();
  updateTimeReadout();
  updateInspector();
  setStatus('');
}

function fitZoom() {
  const vw = waveScroll.clientWidth || 800;
  state.pxPerSec = clampZoom(vw / Math.max(1, state.duration));
  $('zoom-label').textContent = Math.round(state.pxPerSec) + ' px/s';
}

function clampZoom(z) {
  return Math.max(8, Math.min(800, z));
}

function enableControls(on) {
  ['btn-play', 'btn-stop', 'btn-prev-beat', 'btn-next-beat',
   'btn-prev-section', 'btn-next-section', 'btn-add-section', 'btn-add-chord',
   'btn-add-beat', 'btn-delete', 'btn-zoom-in', 'btn-zoom-out', 'btn-save'].forEach((id) => ($(id).disabled = !on));
}

// ----------------------------------------------------------------------------
// Geometry / canvas layout
// ----------------------------------------------------------------------------
const sectionLaneTop = () => RULER_H;
const chordLaneTop = () => RULER_H + SECTION_LANE_H;
const bodyTop = () => RULER_H + SECTION_LANE_H + CHORD_LANE_H;
function tx(t) { return t * state.pxPerSec - waveScroll.scrollLeft; }       // time -> viewport x
function xToTime(x) { return (x + waveScroll.scrollLeft) / state.pxPerSec; } // viewport x -> time

function layoutCanvas() {
  const h = waveScroll.clientHeight;
  const vw = waveScroll.clientWidth;
  state.totalW = Math.max(vw, Math.round(state.duration * state.pxPerSec));
  state._vw = vw;
  state._h = h;

  waveStage.style.width = state.totalW + 'px';
  waveSticky.style.width = vw + 'px';

  const dpr = window.devicePixelRatio || 1;
  for (const c of [waveCanvas, overlayCanvas]) {
    c.style.width = vw + 'px';
    c.style.height = h + 'px';
    c.width = Math.round(vw * dpr);
    c.height = Math.round(h * dpr);
  }
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ensurePeaks();
}

// ----------------------------------------------------------------------------
// Waveform peak cache (computed once per zoom level)
// ----------------------------------------------------------------------------
let peakMin = null, peakMax = null, peaksForW = -1, peaksForBuf = null;
let _mono = null, _monoFor = null;

function mixToMono() {
  if (_monoFor === state.buffer && _mono) return _mono;
  const b = state.buffer;
  const ch0 = b.getChannelData(0);
  if (b.numberOfChannels === 1) { _mono = ch0; }
  else {
    const ch1 = b.getChannelData(1);
    const out = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) out[i] = (ch0[i] + ch1[i]) * 0.5;
    _mono = out;
  }
  _monoFor = state.buffer;
  return _mono;
}

function buildPeaks() {
  const cols = Math.max(1, Math.ceil(state.totalW));
  const data = mixToMono();
  const spp = data.length / state.totalW;
  peakMin = new Float32Array(cols);
  peakMax = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const s = Math.floor(c * spp);
    const e = Math.min(data.length, Math.floor((c + 1) * spp));
    let mn = 1, mx = -1;
    for (let i = s; i < e; i++) {
      const v = data[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (s >= e) { mn = 0; mx = 0; }
    peakMin[c] = mn;
    peakMax[c] = mx;
  }
  peaksForW = state.totalW;
  peaksForBuf = state.buffer;
}

function ensurePeaks() {
  if (!state.buffer) return;
  if (peaksForW !== state.totalW || peaksForBuf !== state.buffer) buildPeaks();
}

// ----------------------------------------------------------------------------
// Static render (ruler + sections + waveform + beats) — viewport only
// ----------------------------------------------------------------------------
const SECTION_PALETTE = ['#4f9dff', '#ffb454', '#7ee081', '#ff7eb6', '#b78bff', '#56d4d4'];

function renderStatic() {
  if (!state.buffer) return;
  ensurePeaks();
  const vw = state._vw, h = state._h;
  const scrollLeft = waveScroll.scrollLeft;
  const bt = bodyTop();
  const bodyH = h - bt;
  const mid = bt + bodyH / 2;

  // backgrounds
  wctx.clearRect(0, 0, vw, h);
  wctx.fillStyle = '#0e1116';
  wctx.fillRect(0, 0, vw, h);
  wctx.fillStyle = '#11151b';
  wctx.fillRect(0, 0, vw, RULER_H);
  wctx.fillStyle = '#0c0f14';
  wctx.fillRect(0, sectionLaneTop(), vw, SECTION_LANE_H);
  wctx.fillStyle = '#0a0d12';
  wctx.fillRect(0, chordLaneTop(), vw, CHORD_LANE_H);

  drawRuler(vw, scrollLeft);

  // --- sections (visible only) ---
  const slTop = sectionLaneTop();
  const sorted = [...state.sections].sort((a, b) => a.time - b.time);
  sorted.forEach((sec, i) => {
    const x0 = tx(sec.time);
    const x1 = tx(sectionEnd(sec));
    if (x1 < 0 || x0 > vw) return;
    const col = SECTION_PALETTE[i % SECTION_PALETTE.length];
    wctx.fillStyle = hexA(col, 0.13);
    wctx.fillRect(x0, bt, x1 - x0, bodyH);
    const selected = state.selected && state.selected.kind === 'section' && state.selected.obj === sec;
    // tab
    wctx.fillStyle = selected ? col : hexA(col, 0.5);
    wctx.fillRect(x0, slTop, Math.max(2, x1 - x0), SECTION_LANE_H);
    // start divider (full height, through the lanes and waveform)
    wctx.strokeStyle = col;
    wctx.lineWidth = selected ? 2 : 1;
    wctx.beginPath();
    wctx.moveTo(x0 + 0.5, slTop);
    wctx.lineTo(x0 + 0.5, h);
    wctx.stroke();
    // label
    wctx.fillStyle = '#0e1116';
    wctx.font = '11px system-ui, sans-serif';
    wctx.textBaseline = 'middle';
    wctx.save();
    wctx.beginPath();
    wctx.rect(x0 + 4, slTop, Math.max(0, x1 - x0 - 6), SECTION_LANE_H);
    wctx.clip();
    wctx.fillText(sec.name || '(unnamed)', x0 + 6, slTop + SECTION_LANE_H / 2 + 1);
    wctx.restore();
  });

  drawChords(vw);

  // --- waveform (read straight from the peak cache) ---
  wctx.strokeStyle = '#3a4756';
  wctx.beginPath();
  const base = Math.floor(scrollLeft);
  for (let x = 0; x < vw; x++) {
    const col = base + x;
    if (col < 0 || col >= peakMin.length) continue;
    wctx.moveTo(x + 0.5, mid + peakMin[col] * (bodyH / 2) * 0.95);
    wctx.lineTo(x + 0.5, mid + peakMax[col] * (bodyH / 2) * 0.95);
  }
  wctx.stroke();

  // --- beats (binary-search the visible window, then draw) ---
  const tStart = xToTime(-2);
  let i = lowerBound(tStart);
  for (; i < state.beats.length; i++) {
    const x = tx(state.beats[i].t);
    if (x > vw + 2) break;
    const selected = state.selected && state.selected.kind === 'beat' && state.selected.obj === state.beats[i];
    wctx.strokeStyle = selected ? '#ff5d5d' : 'rgba(126,224,129,0.75)';
    wctx.lineWidth = selected ? 2 : 1;
    wctx.beginPath();
    wctx.moveTo(x + 0.5, bt);
    wctx.lineTo(x + 0.5, h);
    wctx.stroke();
  }
}

function drawRuler(vw, scrollLeft) {
  // pick a tick step that lands near ~80px apart
  const targetPx = 80;
  const rawStep = targetPx / state.pxPerSec; // seconds
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  let step = candidates[candidates.length - 1];
  for (const c of candidates) { if (c >= rawStep) { step = c; break; } }

  wctx.fillStyle = '#8b96a3';
  wctx.strokeStyle = '#2d343d';
  wctx.font = '10px system-ui, sans-serif';
  wctx.textBaseline = 'top';
  wctx.lineWidth = 1;

  const tFirst = Math.floor((scrollLeft / state.pxPerSec) / step) * step;
  for (let t = tFirst; ; t += step) {
    const x = tx(t);
    if (x > vw) break;
    if (x < -40) continue;
    wctx.beginPath();
    wctx.moveTo(x + 0.5, RULER_H - 6);
    wctx.lineTo(x + 0.5, RULER_H);
    wctx.stroke();
    wctx.fillText(fmtTime(t), x + 3, 3);
  }
  // lane separators
  wctx.strokeStyle = '#2d343d';
  wctx.beginPath();
  for (const yy of [RULER_H, chordLaneTop(), bodyTop()]) {
    wctx.moveTo(0, yy + 0.5); wctx.lineTo(vw, yy + 0.5);
  }
  wctx.stroke();
}

// ----------------------------------------------------------------------------
// Chord lane
// ----------------------------------------------------------------------------
function chordEnd(ch) {
  // first chord that starts strictly after this one (sorted) -> O(log n)
  let lo = 0, hi = state.chords.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (state.chords[m].time <= ch.time) lo = m + 1; else hi = m;
  }
  return lo < state.chords.length ? state.chords[lo].time : state.duration;
}

// Stable hue per chord name -> runs of the same chord share a colour and read
// as one continuous band even though each event stays individually selectable.
function chordHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function drawChords(vw) {
  const top = chordLaneTop();
  const h = CHORD_LANE_H;
  wctx.font = '11px system-ui, sans-serif';
  wctx.textBaseline = 'middle';

  const tStart = xToTime(-2);
  let i = lowerBoundChord(tStart);
  // back up one so a chord starting left of the viewport still paints its block
  if (i > 0) i--;
  let labeledFirst = false; // pin the leftmost visible run's label to the edge
  for (; i < state.chords.length; i++) {
    const ch = state.chords[i];
    const x0 = tx(ch.time);
    if (x0 > vw) break;
    const x1 = tx(chordEnd(ch));
    if (x1 < 0) continue;
    const prev = i > 0 ? state.chords[i - 1] : null;
    const isNew = !prev || prev.chord !== ch.chord;
    const selected = state.selected && state.selected.kind === 'chord' && state.selected.obj === ch;
    const hue = chordHue(ch.chord || '');

    // block fill (same-named neighbours share colour -> look merged)
    wctx.fillStyle = `hsla(${hue}, 55%, 50%, ${selected ? 0.6 : 0.32})`;
    wctx.fillRect(x0, top, Math.max(0.5, x1 - x0), h);

    if (selected) {
      wctx.strokeStyle = '#fff';
      wctx.lineWidth = 2;
      wctx.strokeRect(x0 + 1, top + 1, Math.max(1, x1 - x0 - 2), h - 2);
    } else if (isNew) {
      // boundary divider only where the chord actually changes
      wctx.strokeStyle = `hsl(${hue}, 60%, 70%)`;
      wctx.lineWidth = 1;
      wctx.beginPath();
      wctx.moveTo(x0 + 0.5, top);
      wctx.lineTo(x0 + 0.5, top + h);
      wctx.stroke();
    }

    // label at the start of each run; also force the first visible block so a
    // chord held across the viewport edge keeps a (left-pinned) label
    if (ch.chord && (isNew || !labeledFirst)) {
      const cx = Math.max(x0, 0);              // clip to the on-screen block extent
      wctx.save();
      wctx.beginPath();
      wctx.rect(cx, top, Math.max(0, x1 - cx), h);
      wctx.clip();
      wctx.fillStyle = '#f2f5f8';
      wctx.fillText(ch.chord, Math.max(x0 + 5, cx + 3), top + h / 2 + 1);
      wctx.restore();
    }
    labeledFirst = true;
  }
}

function lowerBoundChord(t) {
  let lo = 0, hi = state.chords.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (state.chords[mid].time < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function fmtTime(t) {
  if (t < 0) t = 0;
  if (t >= 60) {
    let m = Math.floor(t / 60);
    let s = Math.round(t - m * 60);
    if (s === 60) { m += 1; s = 0; }
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  return (t % 1 ? t.toFixed(1) : t.toFixed(0)) + 's';
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function sectionEnd(sec) {
  let end = state.duration;
  for (const s of state.sections) {
    if (s.time > sec.time && s.time < end) end = s.time;
  }
  return end;
}

// ----------------------------------------------------------------------------
// Playhead overlay
// ----------------------------------------------------------------------------
function playPos() {
  if (!state.playing) return state.currentTime;
  return state.startOffset + (ctx().currentTime - state.ctxStartTime);
}

function drawPlayhead() {
  const vw = state._vw, h = state._h;
  octx.clearRect(0, 0, vw, h);
  const x = tx(state.playing ? playPos() : state.currentTime);
  if (x < -1 || x > vw + 1) return;
  octx.strokeStyle = '#ffffff';
  octx.lineWidth = 1.5;
  octx.beginPath();
  octx.moveTo(x + 0.5, 0);
  octx.lineTo(x + 0.5, h);
  octx.stroke();
  // little playhead handle in the ruler
  octx.fillStyle = '#ffffff';
  octx.beginPath();
  octx.moveTo(x - 4, 0); octx.lineTo(x + 4, 0); octx.lineTo(x + 0.5, 6);
  octx.closePath();
  octx.fill();
}

// ----------------------------------------------------------------------------
// Playback (Web Audio)
// ----------------------------------------------------------------------------
function startPlayback() {
  if (!state.buffer || state.playing) return;
  ctx().resume();
  let offset = state.currentTime;
  if (offset >= state.duration - 0.01) offset = 0;
  const src = ctx().createBufferSource();
  src.buffer = state.buffer;
  src.connect(ctx().destination);
  src.onended = () => { if (state.source === src) onPlaybackEnded(); };
  state.source = src;
  state.startOffset = offset;
  state.ctxStartTime = ctx().currentTime;
  state.playing = true;
  state.nextBeatIdx = lowerBound(offset);
  src.start(0, offset);
  startScheduler();
  loop();
  $('btn-play').textContent = '⏸ Pause';
}

function pausePlayback() {
  if (!state.playing) return;
  state.currentTime = Math.min(state.duration, playPos());
  teardownTransport();
}

function stopPlayback() { teardownTransport(); }

function onPlaybackEnded() {
  state.currentTime = state.duration;
  teardownTransport();
  drawPlayhead();
  updateTimeReadout();
}

function teardownTransport() {
  if (state.source) {
    try { state.source.onended = null; state.source.stop(); } catch (e) {}
    state.source = null;
  }
  state.playing = false;
  if (state.schedTimer) { clearInterval(state.schedTimer); state.schedTimer = null; }
  if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; }
  $('btn-play').textContent = '▶ Play';
}

function togglePlay() { state.playing ? pausePlayback() : startPlayback(); }

function seekTo(t) {
  t = Math.max(0, Math.min(state.duration, t));
  if (state.playing) {
    teardownTransport();
    state.currentTime = t;
    startPlayback();
  } else {
    state.currentTime = t;
    drawPlayhead();
    updateTimeReadout();
  }
}

function loop() {
  drawPlayhead();
  updateTimeReadout();
  if ($('chk-follow').checked) followPlayhead();
  state.raf = requestAnimationFrame(loop);
}

function followPlayhead() {
  const x = tx(playPos());
  if (x < 60 || x > state._vw - 60) {
    const target = playPos() * state.pxPerSec - state._vw * 0.5;
    waveScroll.scrollLeft = Math.max(0, Math.min(state.totalW - state._vw, target));
  }
}

// ----------------------------------------------------------------------------
// Metronome
// ----------------------------------------------------------------------------
function lowerBound(t) {
  let lo = 0, hi = state.beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (state.beats[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function startScheduler() {
  state.schedTimer = setInterval(scheduleClicks, SCHED_MS);
  scheduleClicks();
}

function scheduleClicks() {
  if (!$('chk-metro').checked) return;
  const horizon = playPos() + LOOKAHEAD;
  while (state.nextBeatIdx < state.beats.length && state.beats[state.nextBeatIdx].t < horizon) {
    const bt = state.beats[state.nextBeatIdx].t;
    if (bt >= state.startOffset) {
      const when = state.ctxStartTime + (bt - state.startOffset);
      if (when >= ctx().currentTime) scheduleClick(when);
    }
    state.nextBeatIdx++;
  }
}

/* Synthesised metronome click. To use a real sample instead, decode it into
 * `clickBuffer` (see loadClickSample) and it will be played in place of this. */
let clickBuffer = null;
function scheduleClick(when) {
  const c = ctx();
  if (clickBuffer) {
    const s = c.createBufferSource();
    s.buffer = clickBuffer;
    const g = c.createGain();
    g.gain.value = 0.9;
    s.connect(g).connect(c.destination);
    s.start(when);
    return;
  }
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(1800, when);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.6, when + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
  osc.connect(g).connect(c.destination);
  osc.start(when);
  osc.stop(when + 0.05);
}

async function loadClickSample(url) {
  const buf = await fetch(url).then((r) => r.arrayBuffer());
  clickBuffer = await ctx().decodeAudioData(buf);
}
window.loadClickSample = loadClickSample;

// ----------------------------------------------------------------------------
// Editing: beats & sections
// ----------------------------------------------------------------------------
function markDirty() {
  state.dirty = true;
  $('btn-save').textContent = '💾 Save *';
}

function resortBeats() { state.beats.sort((a, b) => a.t - b.t); }

function snapToBeat(t) {
  if (!state.beats.length) return t;
  let best = state.beats[0].t, bd = Math.abs(best - t);
  for (const b of state.beats) {
    const d = Math.abs(b.t - t);
    if (d < bd) { bd = d; best = b.t; }
  }
  return best;
}

function addBeatAt(t) {
  const b = { t: Math.max(0, Math.min(state.duration, t)) };
  state.beats.push(b);
  resortBeats();
  if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  state.selected = { kind: 'beat', obj: b };
  markDirty();
  scheduleRender();
  updateInspector();
}

function addSectionAtPlayhead() {
  const raw = state.playing ? playPos() : state.currentTime;
  const t = snapToBeat(raw);
  const existing = state.sections.find((s) => Math.abs(s.time - t) < 1e-3);
  if (existing) {
    state.selected = { kind: 'section', obj: existing };
  } else {
    const sec = { time: t, name: `section ${state.sections.length + 1}` };
    state.sections.push(sec);
    state.sections.sort((a, b) => a.time - b.time);
    state.selected = { kind: 'section', obj: sec };
    markDirty();
  }
  scheduleRender();
  updateInspector();
  setTimeout(() => { $('section-name').focus(); $('section-name').select(); }, 0);
}

function addChordAtPlayhead() {
  const raw = state.playing ? playPos() : state.currentTime;
  const t = snapToBeat(raw);
  const existing = state.chords.find((c) => Math.abs(c.time - t) < 1e-3);
  if (existing) {
    state.selected = { kind: 'chord', obj: existing };
  } else {
    const ch = { time: t, chord: 'N.C.' };
    state.chords.push(ch);
    state.chords.sort((a, b) => a.time - b.time);
    state.selected = { kind: 'chord', obj: ch };
    markDirty();
  }
  scheduleRender();
  updateInspector();
  setTimeout(() => { $('chord-name').focus(); $('chord-name').select(); }, 0);
}

// ----------------------------------------------------------------------------
// Navigation: jump the playhead to the prev/next beat or section
// ----------------------------------------------------------------------------
function curPos() { return state.playing ? playPos() : state.currentTime; }

function jumpBeat(dir) {
  if (!state.beats.length) return;
  const pos = curPos();
  let target = null;
  if (dir > 0) {
    target = state.beats.find((b) => b.t > pos + 1e-3);
  } else {
    for (const b of state.beats) { if (b.t < pos - 1e-3) target = b; else break; }
  }
  if (!target) return;
  state.selected = { kind: 'beat', obj: target };
  seekTo(target.t);
  scheduleRender();
  updateInspector();
}

function jumpSection(dir) {
  if (!state.sections.length) return;
  const secs = [...state.sections].sort((a, b) => a.time - b.time);
  const pos = curPos();
  let target = null;
  if (dir > 0) {
    target = secs.find((s) => s.time > pos + 1e-3);
  } else {
    for (const s of secs) { if (s.time < pos - 1e-3) target = s; else break; }
  }
  if (!target) return;
  state.selected = { kind: 'section', obj: target };
  seekTo(target.time);
  scheduleRender();
  updateInspector();
}

function deleteSelected() {
  if (!state.selected) return;
  if (state.selected.kind === 'beat') {
    const i = state.beats.indexOf(state.selected.obj);
    if (i >= 0) state.beats.splice(i, 1);
    if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  } else if (state.selected.kind === 'chord') {
    const i = state.chords.indexOf(state.selected.obj);
    if (i >= 0) state.chords.splice(i, 1);
  } else {
    const i = state.sections.indexOf(state.selected.obj);
    if (i >= 0) state.sections.splice(i, 1);
  }
  state.selected = null;
  markDirty();
  scheduleRender();
  updateInspector();
}

// ----------------------------------------------------------------------------
// Inspector panel
// ----------------------------------------------------------------------------
function updateInspector() {
  $('inspector-empty').classList.add('hidden');
  $('inspector-beat').classList.add('hidden');
  $('inspector-section').classList.add('hidden');
  $('inspector-chord').classList.add('hidden');
  $('btn-delete').disabled = !state.selected;

  if (!state.selected) { $('inspector-empty').classList.remove('hidden'); return; }

  if (state.selected.kind === 'beat') {
    $('inspector-beat').classList.remove('hidden');
    const idx = state.beats.indexOf(state.selected.obj);
    $('beat-index').textContent = idx >= 0 ? `${idx + 1} / ${state.beats.length}` : '—';
    $('beat-time').value = state.selected.obj.t.toFixed(3);
  } else if (state.selected.kind === 'chord') {
    $('inspector-chord').classList.remove('hidden');
    const c = state.selected.obj;
    $('chord-name').value = c.chord;
    $('chord-time').value = c.time.toFixed(3);
    $('chord-end').textContent = chordEnd(c).toFixed(3) + ' s';
  } else {
    $('inspector-section').classList.remove('hidden');
    const s = state.selected.obj;
    $('section-name').value = s.name;
    $('section-time').value = s.time.toFixed(3);
    $('section-end').textContent = sectionEnd(s).toFixed(3) + ' s';
  }
}

$('beat-time').addEventListener('change', (e) => {
  if (!state.selected || state.selected.kind !== 'beat') return;
  const v = parseFloat(e.target.value);
  if (!isNaN(v)) {
    state.selected.obj.t = Math.max(0, Math.min(state.duration, v));
    resortBeats();
    if (state.playing) state.nextBeatIdx = lowerBound(playPos());
    markDirty();
    scheduleRender();
    updateInspector();
  }
});
$('beat-delete').addEventListener('click', deleteSelected);

$('section-name').addEventListener('input', (e) => {
  if (!state.selected || state.selected.kind !== 'section') return;
  state.selected.obj.name = e.target.value;
  markDirty();
  scheduleRender();
});
$('section-time').addEventListener('change', (e) => {
  if (!state.selected || state.selected.kind !== 'section') return;
  const v = parseFloat(e.target.value);
  if (!isNaN(v)) {
    state.selected.obj.time = Math.max(0, Math.min(state.duration, v));
    state.sections.sort((a, b) => a.time - b.time);
    markDirty();
    scheduleRender();
    updateInspector();
  }
});
$('section-snap').addEventListener('click', () => {
  if (!state.selected || state.selected.kind !== 'section') return;
  state.selected.obj.time = snapToBeat(state.selected.obj.time);
  state.sections.sort((a, b) => a.time - b.time);
  markDirty();
  scheduleRender();
  updateInspector();
});
$('section-delete').addEventListener('click', deleteSelected);

$('chord-name').addEventListener('input', (e) => {
  if (!state.selected || state.selected.kind !== 'chord') return;
  state.selected.obj.chord = e.target.value;
  markDirty();
  scheduleRender();
});
$('chord-time').addEventListener('change', (e) => {
  if (!state.selected || state.selected.kind !== 'chord') return;
  const v = parseFloat(e.target.value);
  if (!isNaN(v)) {
    state.selected.obj.time = Math.max(0, Math.min(state.duration, v));
    state.chords.sort((a, b) => a.time - b.time);
    markDirty();
    scheduleRender();
    updateInspector();
  }
});
$('chord-snap').addEventListener('click', () => {
  if (!state.selected || state.selected.kind !== 'chord') return;
  state.selected.obj.time = snapToBeat(state.selected.obj.time);
  state.chords.sort((a, b) => a.time - b.time);
  markDirty();
  scheduleRender();
  updateInspector();
});
$('chord-delete').addEventListener('click', deleteSelected);

// ----------------------------------------------------------------------------
// Canvas interaction (scrub / click / drag)
// ----------------------------------------------------------------------------
let drag = null; // {kind:'scrub'|'beat'|'section'|'chord', ...}

waveCanvas.addEventListener('pointerdown', (e) => {
  if (!state.buffer) return;
  const rect = waveCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const t = xToTime(x);

  // Top ruler -> scrub
  if (y < RULER_H) {
    const wasPlaying = state.playing;
    if (state.playing) pausePlayback();
    state.currentTime = Math.max(0, Math.min(state.duration, t));
    drag = { kind: 'scrub', wasPlaying };
    waveCanvas.setPointerCapture(e.pointerId);
    drawPlayhead();
    updateTimeReadout();
    return;
  }

  // Section lane -> select / drag a section
  if (y < chordLaneTop()) {
    const sec = sectionAtX(x);
    if (sec) {
      state.selected = { kind: 'section', obj: sec };
      drag = { kind: 'section', obj: sec };
      waveCanvas.setPointerCapture(e.pointerId);
      scheduleRender();
      updateInspector();
      return;
    }
  }

  // Chord lane -> select / drag a chord
  if (y < bodyTop()) {
    const ch = chordAtX(x);
    if (ch) {
      state.selected = { kind: 'chord', obj: ch };
      drag = { kind: 'chord', obj: ch };
      waveCanvas.setPointerCapture(e.pointerId);
      scheduleRender();
      updateInspector();
    }
    return; // clicks in the chord lane never seek
  }

  // Body -> beats (nearest within tolerance) else seek / shift-add
  const b = beatNear(x);
  if (b) {
    state.selected = { kind: 'beat', obj: b };
    drag = { kind: 'beat', obj: b };
    waveCanvas.setPointerCapture(e.pointerId);
    scheduleRender();
    updateInspector();
  } else if (e.shiftKey) {
    addBeatAt(t);
  } else {
    seekTo(t);
  }
});

waveCanvas.addEventListener('pointermove', (e) => {
  const rect = waveCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (!drag) {
    waveCanvas.style.cursor = y < RULER_H ? 'ew-resize' : 'crosshair';
    return;
  }
  const t = Math.max(0, Math.min(state.duration, xToTime(x)));
  if (drag.kind === 'scrub') {
    state.currentTime = t;
    drawPlayhead();
    updateTimeReadout();
  } else if (drag.kind === 'beat') {
    drag.obj.t = t;
    markDirty();
    scheduleRender();
    updateInspector();
  } else {
    drag.obj.time = t;
    markDirty();
    scheduleRender();
    updateInspector();
  }
});

waveCanvas.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.kind === 'scrub') {
    if (drag.wasPlaying) startPlayback();
  } else if (drag.kind === 'beat') {
    resortBeats();
    if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  } else if (drag.kind === 'section') {
    drag.obj.time = snapToBeat(drag.obj.time);
    state.sections.sort((a, b) => a.time - b.time);
  } else if (drag.kind === 'chord') {
    drag.obj.time = snapToBeat(drag.obj.time);
    state.chords.sort((a, b) => a.time - b.time);
  }
  drag = null;
  scheduleRender();
  updateInspector();
});

function beatNear(x) {
  // beats sorted -> only test the few near the cursor
  const tStart = xToTime(x - BEAT_HIT_PX - 1);
  let best = null, bd = BEAT_HIT_PX + 1;
  for (let i = lowerBound(tStart); i < state.beats.length; i++) {
    const bx = tx(state.beats[i].t);
    if (bx > x + BEAT_HIT_PX + 1) break;
    const d = Math.abs(bx - x);
    if (d < bd) { bd = d; best = state.beats[i]; }
  }
  return best;
}

function sectionAtX(x) {
  let found = null;
  for (const s of state.sections) {
    if (x >= tx(s.time) && x < tx(sectionEnd(s))) found = s;
  }
  return found;
}

function chordAtX(x) {
  const t = xToTime(x);
  let found = null;
  // chords sorted by time -> the matching event is the last one starting <= t
  for (let i = 0; i < state.chords.length; i++) {
    if (state.chords[i].time <= t + 1e-9) found = state.chords[i]; else break;
  }
  if (found && t < chordEnd(found)) return found;
  return null;
}

// ----------------------------------------------------------------------------
// Render scheduling (coalesce redraws into animation frames)
// ----------------------------------------------------------------------------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderStatic();
    if (!state.playing) drawPlayhead();
  });
}

// scrolling only shifts the window -> cheap viewport redraw
waveScroll.addEventListener('scroll', () => {
  if (!state.buffer) return;
  scheduleRender();
  if (!state.playing) drawPlayhead();
});

// ----------------------------------------------------------------------------
// Zoom (anchored on the viewport centre)
// ----------------------------------------------------------------------------
function setZoom(z) {
  const anchorTime = xToTime(state._vw / 2);
  state.pxPerSec = clampZoom(z);
  $('zoom-label').textContent = Math.round(state.pxPerSec) + ' px/s';
  layoutCanvas();
  const target = anchorTime * state.pxPerSec - state._vw / 2;
  waveScroll.scrollLeft = Math.max(0, Math.min(state.totalW - state._vw, target));
  renderStatic();
  drawPlayhead();
}

$('btn-zoom-in').addEventListener('click', () => setZoom(state.pxPerSec * 1.5));
$('btn-zoom-out').addEventListener('click', () => setZoom(state.pxPerSec / 1.5));

// ----------------------------------------------------------------------------
// Save
// ----------------------------------------------------------------------------
async function save() {
  if (!state.current) return;
  setStatus('saving…');
  const stem = state.current.stem;
  try {
    await Promise.all([
      fetch(`/api/beats/${stem}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beats: state.beats.map((b) => b.t) }),
      }),
      fetch(`/api/sections/${stem}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections: state.sections }),
      }),
      fetch(`/api/chords/${stem}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chords: state.chords }),
      }),
    ]);
    state.dirty = false;
    $('btn-save').textContent = '💾 Save';
    setStatus('saved ✓');
    const song = state.songs.find((s) => s.stem === stem);
    if (song) {
      song.has_sections = state.sections.length > 0;
      song.has_chords = state.chords.length > 0;
      renderSongList();
    }
    setTimeout(() => setStatus(''), 1500);
  } catch (err) {
    setStatus('save failed');
    console.error(err);
  }
}

function setStatus(s) { $('status').textContent = s; }
function updateTimeReadout() {
  $('time-readout').textContent =
    `${(state.playing ? playPos() : state.currentTime).toFixed(3)} / ${state.duration.toFixed(3)}`;
}

// ----------------------------------------------------------------------------
// Toolbar & keyboard wiring
// ----------------------------------------------------------------------------
$('btn-play').addEventListener('click', togglePlay);
$('btn-stop').addEventListener('click', () => { stopPlayback(); seekTo(0); });
$('btn-prev-beat').addEventListener('click', () => jumpBeat(-1));
$('btn-next-beat').addEventListener('click', () => jumpBeat(1));
$('btn-prev-section').addEventListener('click', () => jumpSection(-1));
$('btn-next-section').addEventListener('click', () => jumpSection(1));
$('btn-add-section').addEventListener('click', addSectionAtPlayhead);
$('btn-add-chord').addEventListener('click', addChordAtPlayhead);
$('btn-add-beat').addEventListener('click', () => addBeatAt(state.playing ? playPos() : state.currentTime));
$('btn-delete').addEventListener('click', deleteSelected);
$('btn-save').addEventListener('click', save);

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (!state.current) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? jumpSection(1) : jumpBeat(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? jumpSection(-1) : jumpBeat(-1); }
  else if (e.key === 's' || e.key === 'S') { e.preventDefault(); addSectionAtPlayhead(); }
  else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); addChordAtPlayhead(); }
  else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); addBeatAt(state.playing ? playPos() : state.currentTime); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
});

window.addEventListener('resize', () => {
  if (!state.buffer) return;
  layoutCanvas();
  renderStatic();
  drawPlayhead();
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
loadSongs();
