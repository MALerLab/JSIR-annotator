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
  beats: [],            // [{t, db}] (kept sorted)
  sections: [],         // [{time, name}] (kept sorted)
  chords: [],           // [{time, chord}] (kept sorted)
  selected: null,       // {kind:'section'|'chord', obj} OR {kind:'beat', obj:<anchor>}
  selBeats: new Set(),  // selected beat objects (source of truth for beats)
  loop: null,           // {start, end} ruler loop/selection region, or null
  undo: null,           // single-level undo snapshot (beats/sections/chords)
  onlyDownbeats: false, // visual: show only downbeat lines on the canvas
  songVol: 1,           // song gain (0..1.5)
  metroVol: 1,          // metronome gain (0..1)
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

// Master gain nodes: song audio and metronome route through their own gains so
// their volumes are independently adjustable (song up to 1.5 = amplified).
let songGain = null, metroGain = null;
function ensureGraph() {
  const c = ctx();
  if (!songGain) { songGain = c.createGain(); songGain.connect(c.destination); }
  if (!metroGain) { metroGain = c.createGain(); metroGain.connect(c.destination); }
  songGain.gain.value = state.songVol;
  metroGain.gain.value = state.metroVol;
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

// The 24 keys (12 roots x major/minor), plus a "None" default. Values are the
// exact strings written to metadata.json under "key".
const KEY_ROOTS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function populateKeySelect() {
  const sel = $('key-select');
  sel.innerHTML = '';
  sel.appendChild(new Option('None', ''));
  for (const [mode, label] of [['maj', 'maj'], ['min', 'min']]) {
    const group = document.createElement('optgroup');
    group.label = label;
    for (const r of KEY_ROOTS) {
      const v = `${r} ${mode}`;
      group.appendChild(new Option(v, v));
    }
    sel.appendChild(group);
  }
}

function renderSongPanel(song) {
  $('panel-empty').classList.add('hidden');
  $('panel-body').classList.remove('hidden');

  // Key dropdown reflects the current annotation ("" == None).
  const sel = $('key-select');
  const key = song.key || '';
  // guard against a legacy/unknown value: fall back to None visually
  sel.value = key;
  if (sel.value !== key) sel.value = '';
  sel.disabled = false;
  $('key-status').textContent = '';

  // editable info fields (saved to metadata.json on change)
  const fields = [
    ['standard', 'Standard', 'text'],
    ['artist', 'Artist', 'text'],
    ['album', 'Album', 'text'],
    ['instrumentation', 'Instrumentation', 'text'],
    ['num_bars', 'Number of Bars', 'number'],
    ['yt_id', 'YouTube ID', 'text'],
    ['musicbrainz_id', 'MusicBrainz ID', 'text'],
  ];
  $('panel-fields').innerHTML = fields
    .map(([k, label, type]) => {
      const val = song[k] == null ? '' : song[k];
      const extra = type === 'number' ? ' step="1" min="0"' : '';
      return `<div class="pf"><label>${label}</label>` +
        `<input type="${type}" data-field="${k}"${extra} value="${escapeHtml(String(val))}" /></div>`;
    })
    .join('');
  updateYtLink(song);
  $('meta-status').textContent = '';

  // default the bar-jump amount to num_bars when available
  const nb = parseInt(song.num_bars, 10);
  $('bar-jump').value = nb > 0 ? nb : 1;

  // refresh-audio available once a song is loaded (unless a job is in flight)
  if (!refreshBusy) {
    $('btn-refresh').disabled = false;
    setRefreshStatus('');
  }
}

function updateYtLink(song) {
  const el = $('panel-yt');
  if (song.yt_id) {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(song.yt_id)}`;
    el.innerHTML = `<a href="${url}" target="_blank" rel="noopener">▶ Open on YouTube</a>`;
  } else {
    el.innerHTML = '';
  }
}

// Save one edited info field to metadata.json and reflect it everywhere.
async function saveMetaField(field, rawValue) {
  if (!state.current) return;
  const value = rawValue.trim();
  const song = state.current;
  song[field] = value;
  const listed = state.songs.find((s) => s.stem === song.stem);
  if (listed) listed[field] = value;
  if (field === 'standard') $('song-title').textContent = value || '(untitled)';
  if (field === 'artist' || field === 'album') {
    $('song-sub').textContent = [song.artist, song.album].filter(Boolean).join(' · ');
  }
  if (field === 'yt_id') updateYtLink(song);
  renderSongList();
  $('meta-status').textContent = 'saving…';
  try {
    const res = await fetch(`/api/meta/${song.stem}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { [field]: value } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    $('meta-status').textContent = 'saved ✓';
    setTimeout(() => { $('meta-status').textContent = ''; }, 1500);
  } catch (err) {
    $('meta-status').textContent = 'save failed';
    console.error(err);
  }
}

$('panel-fields').addEventListener('change', (e) => {
  const inp = e.target.closest('input[data-field]');
  if (inp) saveMetaField(inp.dataset.field, inp.value);
});

$('key-select').addEventListener('change', async (e) => {
  if (!state.current) return;
  const key = e.target.value;
  const song = state.current;
  $('key-status').textContent = 'saving…';
  try {
    const res = await fetch(`/api/key/${song.stem}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    song.key = key;                       // keep in-memory list in sync
    const listed = state.songs.find((s) => s.stem === song.stem);
    if (listed) listed.key = key;
    $('key-status').textContent = 'saved ✓';
    setTimeout(() => { $('key-status').textContent = ''; }, 1500);
  } catch (err) {
    $('key-status').textContent = 'save failed';
    console.error(err);
  }
});

// ---- volume & view controls ------------------------------------------------
function setSongVol(pct) {
  state.songVol = pct / 100;
  if (songGain) songGain.gain.value = state.songVol;
  $('song-vol').value = pct;
  $('song-vol-val').textContent = pct + '%';
}
function setMetroVol(pct) {
  state.metroVol = pct / 100;
  if (metroGain) metroGain.gain.value = state.metroVol;
  $('metro-vol').value = pct;
  $('metro-vol-val').textContent = pct + '%';
}
// Reset per-view controls (volumes + downbeats-only) to defaults on song load.
function resetViewControls() {
  setSongVol(100);
  setMetroVol(100);
  state.onlyDownbeats = false;
  $('chk-only-db').checked = false;
}
$('song-vol').addEventListener('input', (e) => setSongVol(parseInt(e.target.value, 10) || 0));
$('metro-vol').addEventListener('input', (e) => setMetroVol(parseInt(e.target.value, 10) || 0));
$('chk-only-db').addEventListener('change', (e) => {
  state.onlyDownbeats = e.target.checked;
  scheduleRender();
});

// After toggling/selecting any of these, drop focus so global keyboard
// shortcuts (space, B/S/C, etc.) act on the app rather than the control.
['chk-metro', 'chk-follow', 'chk-only-db', 'beat-downbeat', 'beats-downbeat', 'key-select']
  .forEach((id) => $(id).addEventListener('change', (e) => e.target.blur()));

// ---- refresh audio (re-crawl + re-track) -----------------------------------
let refreshBusy = false;
function setRefreshStatus(msg, cls) {
  const el = $('refresh-status');
  el.textContent = msg || '';
  el.className = cls || '';
}

async function refreshAudio() {
  if (!state.current || refreshBusy) return;
  const song = state.current;
  const ytId = (song.yt_id || '').trim();
  if (!ytId) { setRefreshStatus('Set a YouTube ID first.', 'err'); return; }
  if (!confirm(
    `Re-crawl audio from YouTube ID "${ytId}"?\n\n` +
    'This REPLACES the audio and beat tracking and REMOVES all chord & ' +
    'section labels for this song. It cannot be undone.'
  )) return;

  const stem = song.stem;
  refreshBusy = true;
  $('btn-refresh').disabled = true;
  setRefreshStatus('Starting…', 'busy');
  try {
    const res = await fetch(`/api/refresh/${stem}`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    pollRefresh(stem);
  } catch (err) {
    setRefreshStatus('Error: ' + err.message, 'err');
    refreshBusy = false;
    $('btn-refresh').disabled = false;
  }
}

function pollRefresh(stem) {
  fetch(`/api/refresh/${stem}/status`)
    .then((r) => r.json())
    .then(async (job) => {
      if (job.state === 'running') {
        setRefreshStatus(job.message || 'Working…', 'busy');
        setTimeout(() => pollRefresh(stem), 1000);
      } else if (job.state === 'done') {
        setRefreshStatus('Done — reloading…', 'ok');
        await reloadAfterRefresh(stem, job.new_stem || stem);
        refreshBusy = false;
        $('btn-refresh').disabled = !state.current;
        setRefreshStatus('Refreshed ✓', 'ok');
        setTimeout(() => { if (!refreshBusy) setRefreshStatus(''); }, 3000);
      } else { // error / idle
        setRefreshStatus('Error: ' + (job.message || 'failed'), 'err');
        refreshBusy = false;
        $('btn-refresh').disabled = !state.current;
      }
    })
    .catch((err) => {
      setRefreshStatus('Error: ' + err.message, 'err');
      refreshBusy = false;
      $('btn-refresh').disabled = !state.current;
    });
}

async function reloadAfterRefresh(oldStem, newStem) {
  // metadata changed (files re-keyed, labels dropped) -> refresh the list…
  await loadSongs();
  // …then, only if the user is still on this song, reload it with fresh audio.
  if (!state.current || state.current.stem !== oldStem) return;
  const song = state.songs.find((s) => s.stem === newStem)
    || state.songs.find((s) => s.stem === oldStem);
  if (song) {
    state.dirty = false;
    await selectSong(song, { bust: Date.now() });
  }
}

$('btn-refresh').addEventListener('click', refreshAudio);

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

// ----------------------------------------------------------------------------
// Song selection / loading
// ----------------------------------------------------------------------------
async function selectSong(song, opts) {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  stopPlayback();
  state.current = song;
  state.selected = null;
  state.selBeats = new Set();
  state.loop = null;
  state.undo = null;
  state.dirty = false;
  state.currentTime = 0;
  resetViewControls();
  renderSongList();
  setStatus('loading…');
  $('song-title').textContent = song.standard || '(untitled)';
  $('song-sub').textContent = [song.artist, song.album].filter(Boolean).join(' · ');
  renderSongPanel(song);

  let annRes, buffer;
  try {
    // cache-bust after a refresh so the browser doesn't serve stale audio
    const bust = opts && opts.bust ? `?v=${opts.bust}` : '';
    const audioUrl = `/audio/${song.audio.replace(/^audio\//, '')}${bust}`;
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

  state.beats = annRes.beats.map((b) => ({ t: b.time, db: !!b.downbeat }));
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
  return Math.max(4, Math.min(800, z));
}

function enableControls(on) {
  ['btn-play', 'btn-stop', 'btn-jump-back', 'btn-jump-fwd',
   'btn-prev-section', 'btn-next-section', 'btn-add-section', 'btn-add-chord',
   'btn-add-beat', 'btn-double-beats', 'btn-clear-downbeats', 'btn-delete',
   'btn-zoom-in', 'btn-zoom-out', 'btn-save'].forEach((id) => ($(id).disabled = !on));
  // half-beats / deselect depend on the current selection (see updateInspector)
  if (!on) { $('btn-half-beats').disabled = true; $('btn-deselect').disabled = true; }
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
let peakMin = null, peakMax = null, peaksForPps = -1, peaksForBuf = null;
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
  // Peaks span only the AUDIO's pixel width (duration * pxPerSec), not the whole
  // canvas. When the canvas is wider than the audio (zoomed out past fit), the
  // render loop leaves the extra columns blank instead of stretching the wave.
  const audioW = Math.max(1, state.duration * state.pxPerSec);
  const cols = Math.max(1, Math.ceil(audioW));
  const data = mixToMono();
  const spp = data.length / audioW;
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
  peaksForPps = state.pxPerSec;
  peaksForBuf = state.buffer;
}

function ensurePeaks() {
  if (!state.buffer) return;
  if (peaksForPps !== state.pxPerSec || peaksForBuf !== state.buffer) buildPeaks();
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
    // label: name + length in bars, pinned to the left edge when the section's
    // start has scrolled off-screen (so it stays readable — "sticky")
    const label = `${sec.name || '(unnamed)'}  ·  ${fmtBars(sectionBars(sec))}`;
    const clipL = Math.max(x0, 0);
    wctx.fillStyle = '#0e1116';
    wctx.font = '11px system-ui, sans-serif';
    wctx.textBaseline = 'middle';
    wctx.save();
    wctx.beginPath();
    wctx.rect(clipL + 2, slTop, Math.max(0, x1 - clipL - 4), SECTION_LANE_H);
    wctx.clip();
    wctx.fillText(label, Math.max(x0 + 6, 4), slTop + SECTION_LANE_H / 2 + 1);
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
    const beat = state.beats[i];
    const x = tx(beat.t);
    if (x > vw + 2) break;
    const selected = state.selBeats.has(beat);
    // "downbeats only" view: hide non-downbeats (selected beats still show)
    if (state.onlyDownbeats && !beat.db && !selected) continue;
    // downbeats stand out (amber, thicker); selected always wins (red)
    if (selected) { wctx.strokeStyle = '#ff5d5d'; wctx.lineWidth = 2; }
    else if (beat.db) { wctx.strokeStyle = 'rgba(255,170,64,0.95)'; wctx.lineWidth = 2; }
    else { wctx.strokeStyle = 'rgba(126,224,129,0.75)'; wctx.lineWidth = 1; }
    wctx.beginPath();
    wctx.moveTo(x + 0.5, bt);
    wctx.lineTo(x + 0.5, h);
    wctx.stroke();
  }

  drawLoop(vw, h);
}

// Loop / multi-select region: translucent band across the height + solid
// handles in the ruler.
function drawLoop(vw, h) {
  if (!state.loop) return;
  const x0 = tx(state.loop.start);
  const x1 = tx(state.loop.end);
  if (x1 < 0 || x0 > vw) return;
  wctx.fillStyle = 'rgba(255,93,93,0.10)';
  wctx.fillRect(x0, 0, x1 - x0, h);
  wctx.fillStyle = 'rgba(255,93,93,0.55)';
  wctx.fillRect(x0, 0, x1 - x0, RULER_H);
  wctx.strokeStyle = '#ff5d5d';
  wctx.lineWidth = 1;
  wctx.beginPath();
  wctx.moveTo(x0 + 0.5, 0); wctx.lineTo(x0 + 0.5, h);
  wctx.moveTo(x1 + 0.5, 0); wctx.lineTo(x1 + 0.5, h);
  wctx.stroke();
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

// Section length in bars (4/4: 4 beats = 1 bar) = beats within the section / 4.
function sectionBars(sec) {
  const startIdx = lowerBound(sec.time - 1e-9);
  const endIdx = lowerBound(sectionEnd(sec) - 1e-9);
  return Math.max(0, endIdx - startIdx) / 4;
}
function fmtBars(bars) {
  const s = Number.isInteger(bars) ? String(bars) : bars.toFixed(2).replace(/\.?0+$/, '');
  return `${s} bar${bars === 1 ? '' : 's'}`;
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
  ensureGraph();
  let offset = state.currentTime;
  if (offset >= state.duration - 0.01) offset = 0;
  const src = ctx().createBufferSource();
  src.buffer = state.buffer;
  src.connect(songGain);
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
  // wrap playback within the loop region, if one is set
  if (state.loop && state.playing && playPos() >= state.loop.end) {
    seekTo(state.loop.start); // restarts playback (and its own rAF) at the start
    return;
  }
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
    const beat = state.beats[state.nextBeatIdx];
    if (beat.t >= state.startOffset) {
      const when = state.ctxStartTime + (beat.t - state.startOffset);
      if (when >= ctx().currentTime) scheduleClick(when, beat.db);
    }
    state.nextBeatIdx++;
  }
}

/* Synthesised metronome click. To use a real sample instead, decode it into
 * `clickBuffer` (see loadClickSample) and it will be played in place of this. */
let clickBuffer = null;
function scheduleClick(when, downbeat) {
  const c = ctx();
  ensureGraph();
  if (clickBuffer) {
    const s = c.createBufferSource();
    s.buffer = clickBuffer;
    // pitch-shift a downbeat up an octave via playbackRate
    s.playbackRate.value = downbeat ? 1.5 : 1;
    const g = c.createGain();
    g.gain.value = 0.9;
    s.connect(g).connect(metroGain);
    s.start(when);
    return;
  }
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(downbeat ? 3200 : 1600, when);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(downbeat ? 0.75 : 0.6, when + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
  osc.connect(g).connect(metroGain);
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
  pushUndo();
  const b = { t: Math.max(0, Math.min(state.duration, t)), db: false };
  state.beats.push(b);
  resortBeats();
  if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  selectSingleBeat(b);
  markDirty();
  scheduleRender();
  updateInspector();
}

// True when beat `b` falls in the active loop region (or always, if no region).
function inLoopRegion(b) {
  return !state.loop || (b.t >= state.loop.start - 1e-9 && b.t <= state.loop.end + 1e-9);
}

// Double the beat density: insert a midpoint between each consecutive pair. With
// a loop region selected, only pairs entirely inside it are doubled; otherwise
// the whole song. Original beat objects are preserved.
function doubleBeats() {
  const region = state.beats.filter(inLoopRegion);
  if (region.length < 2) return;
  pushUndo();
  const out = [];
  for (let i = 0; i < state.beats.length; i++) {
    out.push(state.beats[i]);
    const a = state.beats[i], b = state.beats[i + 1];
    if (b && inLoopRegion(a) && inLoopRegion(b)) {
      out.push({ t: (a.t + b.t) / 2, db: false });
    }
  }
  state.beats = out;
  if (state.loop) selectBeatsInRange(state.loop.start, state.loop.end);
  if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  markDirty();
  scheduleRender();
  updateInspector();
  setStatus(`${state.loop ? 'doubled region' : 'doubled'} → ${state.beats.length} beats`);
  setTimeout(() => setStatus(''), 1500);
}

// Halve the beats: keep an anchor beat and every other beat aligned to it,
// deleting the rest. With a loop region, this is confined to the region (beats
// outside are untouched); otherwise the whole song. The anchor is the selected
// beat (or, inside a region, the region's first beat if nothing suitable is
// selected).
function halveBeats() {
  const region = state.beats.filter(inLoopRegion);
  if (region.length < 2) return;
  let anchor = (state.selected && state.selected.kind === 'beat' && inLoopRegion(state.selected.obj))
    ? state.selected.obj : null;
  if (!anchor) {
    if (state.loop) anchor = region[0];
    else {
      setStatus('select a beat first to anchor halving');
      setTimeout(() => setStatus(''), 2000);
      return;
    }
  }
  const anchorPos = region.indexOf(anchor);
  if (anchorPos < 0) return;
  // within the region keep every other beat (anchor stays); keep all outside
  const keep = new Set(region.filter((_, i) => ((i - anchorPos) % 2) === 0));
  pushUndo();
  state.beats = state.beats.filter((b) => !inLoopRegion(b) || keep.has(b));
  if (state.loop) selectBeatsInRange(state.loop.start, state.loop.end);
  else reconcileSelection();
  if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  markDirty();
  scheduleRender();
  updateInspector();
  setStatus(`${state.loop ? 'halved region' : 'halved'} → ${state.beats.length} beats`);
  setTimeout(() => setStatus(''), 1500);
}

// Re-grid downbeats (assuming 4/4) for every beat at or after `startTime`:
// the beat at startTime becomes a downbeat, then every 4th beat after it, and
// all other beats in that range are forced to non-downbeat. Beats before
// startTime are left untouched. Used when a section is created.
function applyDownbeatGrid(startTime) {
  if (!state.beats.length) return;
  let startIdx = 0, bd = Infinity;
  for (let i = 0; i < state.beats.length; i++) {
    const d = Math.abs(state.beats[i].t - startTime);
    if (d < bd) { bd = d; startIdx = i; }
  }
  for (let i = startIdx; i < state.beats.length; i++) {
    state.beats[i].db = ((i - startIdx) % 4) === 0;
  }
}

// Global: strip every downbeat flag in the song.
function clearAllDownbeats() {
  if (!state.beats.length) return;
  const had = state.beats.some((b) => b.db);
  if (!had) return;
  pushUndo();
  for (const b of state.beats) b.db = false;
  markDirty();
  scheduleRender();
  updateInspector();
  setStatus('cleared all downbeats');
  setTimeout(() => setStatus(''), 1500);
}

// ---- selection helpers -----------------------------------------------------
// Beats live in state.selBeats (a Set); state.selected mirrors the anchor beat
// (last one interacted with) so single-beat editing and halving keep working.
function setBeatSelection(arr) {
  state.selBeats = new Set(arr);
  state.selected = arr.length ? { kind: 'beat', obj: arr[arr.length - 1] } : null;
}
function selectSingleBeat(b) { setBeatSelection([b]); }
function toggleBeatInSelection(b) {
  if (state.selBeats.has(b)) state.selBeats.delete(b);
  else state.selBeats.add(b);
  const arr = [...state.selBeats];
  state.selected = state.selBeats.size ? { kind: 'beat', obj: b } : null;
  return arr.length;
}
function selectBeatsInRange(a, b) {
  setBeatSelection(state.beats.filter((bt) => bt.t >= a && bt.t <= b));
}
function selectBeatsAfterPlayhead() {
  const pos = curPos();
  const arr = state.beats.filter((b) => b.t >= pos - 1e-6);
  if (!arr.length) return;
  setBeatSelection(arr);
  scheduleRender();
  updateInspector();
  setStatus(`selected ${arr.length} beats`);
  setTimeout(() => setStatus(''), 1200);
}
function selectSectionObj(s) { state.selBeats = new Set(); state.selected = { kind: 'section', obj: s }; }
function selectChordObj(c) { state.selBeats = new Set(); state.selected = { kind: 'chord', obj: c }; }

// Drop from the selection any beat objects no longer present (after halve /
// delete / fill rebuild state.beats).
function reconcileSelection() {
  if (!state.selBeats.size) return;
  const present = new Set(state.beats);
  for (const b of [...state.selBeats]) if (!present.has(b)) state.selBeats.delete(b);
  const arr = [...state.selBeats];
  if (state.selected && state.selected.kind === 'beat' && !present.has(state.selected.obj)) {
    state.selected = arr.length ? { kind: 'beat', obj: arr[arr.length - 1] } : null;
  }
}

function clearSelection() {
  if (!state.selected && !state.selBeats.size) return;
  state.selBeats = new Set();
  state.selected = null;
  scheduleRender();
  updateInspector();
}

// ---- single-level undo -----------------------------------------------------
// pushUndo() snapshots beats/sections/chords BEFORE a mutating action; Ctrl+Z
// restores it (and stashes the current state, so a second Ctrl+Z redoes).
function snapshotState() {
  return {
    beats: state.beats.map((b) => ({ t: b.t, db: b.db })),
    sections: state.sections.map((s) => ({ time: s.time, name: s.name })),
    chords: state.chords.map((c) => ({ time: c.time, chord: c.chord })),
  };
}
function pushUndo() { state.undo = snapshotState(); }
function restoreSnapshot(snap) {
  state.beats = snap.beats.map((b) => ({ t: b.t, db: b.db }));
  state.sections = snap.sections.map((s) => ({ time: s.time, name: s.name }));
  state.chords = snap.chords.map((c) => ({ time: c.time, chord: c.chord }));
  state.selBeats = new Set();
  state.selected = null;
  if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  markDirty();
  scheduleRender();
  updateInspector();
}
function undo() {
  if (!state.undo) { setStatus('nothing to undo'); setTimeout(() => setStatus(''), 1200); return; }
  const cur = snapshotState();
  restoreSnapshot(state.undo);
  state.undo = cur; // press Ctrl+Z again to redo
  setStatus('undo'); setTimeout(() => setStatus(''), 1000);
}

function nudgeSelectedBeats(deltaSec) {
  if (!state.selBeats.size) return;
  pushUndo();
  for (const b of state.selBeats) b.t = Math.max(0, Math.min(state.duration, b.t + deltaSec));
  resortBeats();
  if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  markDirty();
  scheduleRender();
  updateInspector();
}

// Fill: between each consecutive pair of selected beats, insert 3 evenly-spaced
// beats (subdividing the gap into four).
function fillSelectedBeats() {
  const sel = [...state.selBeats].sort((a, b) => a.t - b.t);
  if (sel.length < 2) {
    setStatus('select 2+ beats to fill');
    setTimeout(() => setStatus(''), 2000);
    return;
  }
  pushUndo();
  const additions = [];
  for (let i = 0; i < sel.length - 1; i++) {
    const a = sel[i].t, b = sel[i + 1].t;
    for (let k = 1; k <= 3; k++) additions.push({ t: a + (b - a) * (k / 4), db: false });
  }
  state.beats.push(...additions);
  resortBeats();
  if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  markDirty();
  scheduleRender();
  updateInspector();
  setStatus(`filled → +${additions.length} beats`);
  setTimeout(() => setStatus(''), 1500);
}

function setDownbeatForSelection(on) {
  if (!state.selBeats.size) return;
  pushUndo();
  for (const b of state.selBeats) b.db = on;
  markDirty();
  scheduleRender();
  updateInspector();
}

function addSectionAtPlayhead() {
  const raw = state.playing ? playPos() : state.currentTime;
  const t = snapToBeat(raw);
  state.selBeats = new Set();
  const existing = state.sections.find((s) => Math.abs(s.time - t) < 1e-3);
  if (existing) {
    state.selected = { kind: 'section', obj: existing };
  } else {
    pushUndo();
    const sec = { time: t, name: `section ${state.sections.length + 1}` };
    state.sections.push(sec);
    state.sections.sort((a, b) => a.time - b.time);
    state.selected = { kind: 'section', obj: sec };
    // from this section's start, re-grid downbeats every 4th beat (4/4)
    applyDownbeatGrid(t);
    markDirty();
  }
  scheduleRender();
  updateInspector();
}

function addChordAtPlayhead() {
  const raw = state.playing ? playPos() : state.currentTime;
  const t = snapToBeat(raw);
  state.selBeats = new Set();
  const existing = state.chords.find((c) => Math.abs(c.time - t) < 1e-3);
  if (existing) {
    state.selected = { kind: 'chord', obj: existing };
  } else {
    pushUndo();
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
// Navigation: jump the playhead by N bars, or to the prev/next section
// ----------------------------------------------------------------------------
function curPos() { return state.playing ? playPos() : state.currentTime; }

function nearestBeatIndex(t) {
  if (!state.beats.length) return -1;
  let idx = 0, bd = Infinity;
  for (let i = 0; i < state.beats.length; i++) {
    const d = Math.abs(state.beats[i].t - t);
    if (d < bd) { bd = d; idx = i; }
  }
  return idx;
}

// Jump the playhead by (4 * bars) beats in the given direction (4/4 assumed).
function jumpBars(dir) {
  if (!state.beats.length) return;
  const bars = Math.max(1, parseInt($('bar-jump').value, 10) || 1);
  const step = 4 * bars;
  const cur = nearestBeatIndex(curPos());
  const target = Math.max(0, Math.min(state.beats.length - 1, cur + dir * step));
  seekTo(state.beats[target].t);
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
  selectSectionObj(target);
  seekTo(target.time);
  scheduleRender();
  updateInspector();
}

function deleteSelected() {
  if (state.selBeats.size) {
    pushUndo();
    const del = state.selBeats;
    state.beats = state.beats.filter((b) => !del.has(b));
    state.selBeats = new Set();
    state.selected = null;
    if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  } else if (state.selected && state.selected.kind === 'chord') {
    pushUndo();
    const i = state.chords.indexOf(state.selected.obj);
    if (i >= 0) state.chords.splice(i, 1);
    state.selected = null;
  } else if (state.selected && state.selected.kind === 'section') {
    pushUndo();
    const i = state.sections.indexOf(state.selected.obj);
    if (i >= 0) state.sections.splice(i, 1);
    state.selected = null;
  } else {
    return;
  }
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
  $('inspector-beats').classList.add('hidden');
  $('inspector-section').classList.add('hidden');
  $('inspector-chord').classList.add('hidden');
  const nBeats = state.selBeats.size;
  const hasSel = !!state.selected || nBeats > 0;
  $('btn-delete').disabled = !hasSel;
  $('btn-deselect').disabled = !hasSel;
  // halving needs a beat anchor (single-anchor operation)
  // halving needs a beat anchor, or a loop region (which auto-anchors)
  $('btn-half-beats').disabled = !(state.buffer && ((state.selected && state.selected.kind === 'beat') || state.loop));

  if (nBeats > 1) {
    // multi-beat group inspector
    $('inspector-beats').classList.remove('hidden');
    $('beats-count').textContent = `${nBeats} beats`;
    const arr = [...state.selBeats];
    const allDb = arr.every((b) => b.db);
    const noneDb = arr.every((b) => !b.db);
    const cb = $('beats-downbeat');
    cb.checked = allDb;
    cb.indeterminate = !allDb && !noneDb;
    return;
  }

  if (!state.selected) { $('inspector-empty').classList.remove('hidden'); return; }

  if (state.selected.kind === 'beat') {
    $('inspector-beat').classList.remove('hidden');
    const idx = state.beats.indexOf(state.selected.obj);
    $('beat-index').textContent = idx >= 0 ? `${idx + 1} / ${state.beats.length}` : '—';
    $('beat-time').value = state.selected.obj.t.toFixed(3);
    $('beat-downbeat').checked = !!state.selected.obj.db;
  } else if (state.selected.kind === 'chord') {
    $('inspector-chord').classList.remove('hidden');
    const c = state.selected.obj;
    $('chord-name').value = c.chord;
    $('chord-time').value = c.time.toFixed(3);
    $('chord-end').textContent = chordEnd(c).toFixed(3) + ' s';
  } else {
    $('inspector-section').classList.remove('hidden');
    const s = state.selected.obj;
    // don't stomp what the user is actively typing in the name combobox
    if (document.activeElement !== $('section-name')) $('section-name').value = s.name;
    $('section-time').value = s.time.toFixed(3);
    $('section-end').textContent = sectionEnd(s).toFixed(3) + ' s';
    $('section-bars').textContent = fmtBars(sectionBars(s));
  }
}

$('beat-time').addEventListener('change', (e) => {
  if (!state.selected || state.selected.kind !== 'beat') return;
  const v = parseFloat(e.target.value);
  if (!isNaN(v)) {
    pushUndo();
    state.selected.obj.t = Math.max(0, Math.min(state.duration, v));
    resortBeats();
    if (state.playing) state.nextBeatIdx = lowerBound(playPos());
    markDirty();
    scheduleRender();
    updateInspector();
  }
});
$('beat-downbeat').addEventListener('change', (e) => {
  if (!state.selected || state.selected.kind !== 'beat') return;
  pushUndo();
  state.selected.obj.db = e.target.checked;
  markDirty();
  scheduleRender();
});
$('beat-delete').addEventListener('click', deleteSelected);

$('beats-downbeat').addEventListener('change', (e) => setDownbeatForSelection(e.target.checked));
$('beats-fill').addEventListener('click', fillSelectedBeats);
$('beats-delete').addEventListener('click', deleteSelected);

// --- section-name combobox (preset dropdown + autocomplete) ----------------
const SECTION_PRESETS = [
  'head:horn', 'head:piano', 'head:vocal',
  'solo:horn', 'solo:piano', 'solo:bass',
  'last', 'exchange', 'exclude',
];
let presetActive = -1; // highlighted index in the open dropdown

function applySectionName(val) {
  if (!state.selected || state.selected.kind !== 'section') return;
  $('section-name').value = val;
  state.selected.obj.name = val;
  markDirty();
  scheduleRender();
}
function showSectionPresets() {
  const q = $('section-name').value.toLowerCase();
  const items = SECTION_PRESETS.filter((p) => p.toLowerCase().includes(q));
  const ul = $('section-presets');
  presetActive = -1;
  if (!items.length) { ul.classList.add('hidden'); ul.innerHTML = ''; return; }
  ul.innerHTML = items.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
  ul.classList.remove('hidden');
}
function hideSectionPresets() {
  $('section-presets').classList.add('hidden');
  presetActive = -1;
}
function highlightPreset(delta) {
  const lis = $('section-presets').querySelectorAll('li');
  if (!lis.length) return;
  presetActive = (presetActive + delta + lis.length) % lis.length;
  lis.forEach((li, i) => li.classList.toggle('active', i === presetActive));
}

$('section-name').addEventListener('input', (e) => {
  if (!state.selected || state.selected.kind !== 'section') return;
  state.selected.obj.name = e.target.value;
  markDirty();
  scheduleRender();
  showSectionPresets();
});
$('section-name').addEventListener('focus', showSectionPresets);
$('section-name').addEventListener('mousedown', () => setTimeout(showSectionPresets, 0));
$('section-name').addEventListener('keydown', (e) => {
  const open = !$('section-presets').classList.contains('hidden');
  if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) showSectionPresets(); else highlightPreset(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); highlightPreset(-1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const lis = $('section-presets').querySelectorAll('li');
    if (open && presetActive >= 0 && lis[presetActive]) applySectionName(lis[presetActive].textContent);
    hideSectionPresets();
    e.target.blur(); // hand focus back so shortcuts work
  } else if (e.key === 'Escape') {
    hideSectionPresets();
  }
});
$('section-name').addEventListener('blur', () => setTimeout(hideSectionPresets, 150));
// mousedown fires before the input's blur, so the click always registers
$('section-presets').addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  applySectionName(li.textContent);
  hideSectionPresets();
  $('section-name').blur();
});
$('section-time').addEventListener('change', (e) => {
  if (!state.selected || state.selected.kind !== 'section') return;
  const v = parseFloat(e.target.value);
  if (!isNaN(v)) {
    pushUndo();
    state.selected.obj.time = Math.max(0, Math.min(state.duration, v));
    state.sections.sort((a, b) => a.time - b.time);
    markDirty();
    scheduleRender();
    updateInspector();
  }
});
$('section-snap').addEventListener('click', () => {
  if (!state.selected || state.selected.kind !== 'section') return;
  pushUndo();
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
    pushUndo();
    state.selected.obj.time = Math.max(0, Math.min(state.duration, v));
    state.chords.sort((a, b) => a.time - b.time);
    markDirty();
    scheduleRender();
    updateInspector();
  }
});
$('chord-snap').addEventListener('click', () => {
  if (!state.selected || state.selected.kind !== 'chord') return;
  pushUndo();
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
let drag = null; // {kind:'scrub'|'beat'|'beats'|'section'|'chord'|'loop', ...}
let lastRulerDown = { time: -1e9, x: 0 };

waveCanvas.addEventListener('pointerdown', (e) => {
  if (!state.buffer) return;
  const rect = waveCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const t = xToTime(x);

  // Top ruler -> scrub, or double-click(+drag) -> loop region / multi-select
  if (y < RULER_H) {
    const isSecond = (e.timeStamp - lastRulerDown.time < 400) && Math.abs(x - lastRulerDown.x) < 12;
    lastRulerDown = { time: e.timeStamp, x };
    if (isSecond) {
      // second click of a double: drag = make loop region; no drag = discard it
      drag = { kind: 'loop', startTime: Math.max(0, Math.min(state.duration, t)), startX: x, moved: false };
      waveCanvas.setPointerCapture(e.pointerId);
      return;
    }
    const wasPlaying = state.playing;
    if (state.playing) pausePlayback();
    state.currentTime = Math.max(0, Math.min(state.duration, t));
    drag = { kind: 'scrub', wasPlaying };
    waveCanvas.setPointerCapture(e.pointerId);
    drawPlayhead();
    updateTimeReadout();
    return;
  }

  // Section lane -> select / drag a section, else deselect
  if (y < chordLaneTop()) {
    const sec = sectionAtX(x);
    if (sec) {
      selectSectionObj(sec);
      drag = { kind: 'section', obj: sec };
      waveCanvas.setPointerCapture(e.pointerId);
      scheduleRender();
      updateInspector();
    } else {
      clearSelection();
    }
    return;
  }

  // Chord lane -> select / drag a chord, else deselect (never seeks)
  if (y < bodyTop()) {
    const ch = chordAtX(x);
    if (ch) {
      selectChordObj(ch);
      drag = { kind: 'chord', obj: ch };
      waveCanvas.setPointerCapture(e.pointerId);
      scheduleRender();
      updateInspector();
    } else {
      clearSelection();
    }
    return;
  }

  // Body -> beats. Shift-click toggles multi-selection; clicking a beat already
  // in a multi-selection drags the whole group; otherwise single-select & drag.
  const b = beatNear(x);
  if (b) {
    if (e.shiftKey) {
      toggleBeatInSelection(b);
      scheduleRender();
      updateInspector();
    } else if (state.selBeats.has(b) && state.selBeats.size > 1) {
      drag = { kind: 'beats', startTime: t, orig: [...state.selBeats].map((bb) => ({ bb, t0: bb.t })) };
      waveCanvas.setPointerCapture(e.pointerId);
    } else {
      selectSingleBeat(b);
      drag = { kind: 'beat', obj: b };
      waveCanvas.setPointerCapture(e.pointerId);
      scheduleRender();
      updateInspector();
    }
  } else if (e.shiftKey) {
    addBeatAt(t);
  } else {
    clearSelection();
    seekTo(t);
  }
});

// scrub / loop updates factored out so the edge-scroll loop can reuse them
function applyScrubAt(x) {
  state.currentTime = Math.max(0, Math.min(state.duration, xToTime(x)));
  drawPlayhead();
  updateTimeReadout();
}
function applyLoopAt(x) {
  const t = Math.max(0, Math.min(state.duration, xToTime(x)));
  if (Math.abs(x - drag.startX) > 3) drag.moved = true;
  state.loop = { start: Math.min(drag.startTime, t), end: Math.max(drag.startTime, t) };
  selectBeatsInRange(state.loop.start, state.loop.end);
  scheduleRender();
  updateInspector();
}

// DAW-style edge scrolling: while scrubbing / selecting near a canvas edge,
// keep scrolling to reveal more content (even if the pointer stays still).
const EDGE_ZONE = 48;     // px from each edge that triggers auto-scroll
const EDGE_MAX_PX = 24;   // max scroll step per frame
let edgeRAF = null;
function computeEdgeVel(x) {
  if (x < EDGE_ZONE) return -Math.min(1, (EDGE_ZONE - x) / EDGE_ZONE) * EDGE_MAX_PX;
  if (x > state._vw - EDGE_ZONE) return Math.min(1, (x - (state._vw - EDGE_ZONE)) / EDGE_ZONE) * EDGE_MAX_PX;
  return 0;
}
function updateEdgeScroll() {
  if (!drag || (drag.kind !== 'scrub' && drag.kind !== 'loop')) { drag && (drag.edgeVel = 0); return; }
  drag.edgeVel = computeEdgeVel(drag.lastX);
  if (drag.edgeVel && !edgeRAF) edgeRAF = requestAnimationFrame(edgeTick);
}
function edgeTick() {
  edgeRAF = null;
  if (!drag || !drag.edgeVel || (drag.kind !== 'scrub' && drag.kind !== 'loop')) return;
  const maxScroll = Math.max(0, state.totalW - state._vw);
  const before = waveScroll.scrollLeft;
  const sl = Math.max(0, Math.min(maxScroll, before + drag.edgeVel));
  if (sl !== before) {
    waveScroll.scrollLeft = sl; // fires 'scroll' -> re-renders the waveform
    if (drag.kind === 'scrub') applyScrubAt(drag.lastX);
    else applyLoopAt(drag.lastX);
  }
  if ((drag.edgeVel < 0 && sl > 0) || (drag.edgeVel > 0 && sl < maxScroll)) {
    edgeRAF = requestAnimationFrame(edgeTick);
  }
}
function stopEdgeScroll() {
  if (edgeRAF) { cancelAnimationFrame(edgeRAF); edgeRAF = null; }
  if (drag) drag.edgeVel = 0;
}

waveCanvas.addEventListener('pointermove', (e) => {
  const rect = waveCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (!drag) {
    waveCanvas.style.cursor = y < RULER_H ? 'ew-resize' : 'crosshair';
    return;
  }
  drag.lastX = x;
  const t = Math.max(0, Math.min(state.duration, xToTime(x)));
  if (drag.kind === 'scrub') {
    applyScrubAt(x);
    updateEdgeScroll();
  } else if (drag.kind === 'loop') {
    applyLoopAt(x);
    updateEdgeScroll();
  } else if (drag.kind === 'beat') {
    if (!drag.undone) { pushUndo(); drag.undone = true; }
    drag.obj.t = t;
    markDirty();
    scheduleRender();
    updateInspector();
  } else if (drag.kind === 'beats') {
    if (!drag.undone) { pushUndo(); drag.undone = true; }
    const delta = t - drag.startTime;
    for (const { bb, t0 } of drag.orig) bb.t = Math.max(0, Math.min(state.duration, t0 + delta));
    markDirty();
    scheduleRender();
    updateInspector();
  } else {
    if (!drag.undone) { pushUndo(); drag.undone = true; }
    drag.obj.time = t;
    markDirty();
    scheduleRender();
    updateInspector();
  }
});

waveCanvas.addEventListener('pointerup', () => {
  if (!drag) return;
  stopEdgeScroll();
  if (drag.kind === 'scrub') {
    if (drag.wasPlaying) startPlayback();
  } else if (drag.kind === 'loop') {
    if (!drag.moved || !state.loop || (state.loop.end - state.loop.start) < 0.01) {
      // pure double-click (no drag) -> discard loop region + selection
      state.loop = null;
      clearSelection();
    }
  } else if (drag.kind === 'beat') {
    resortBeats();
    if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  } else if (drag.kind === 'beats') {
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
// setZoom keeps the time under `anchorX` (a viewport x; defaults to centre)
// pinned in place, so wheel-to-zoom feels anchored at the cursor.
function setZoom(z, anchorX) {
  const ax = (anchorX == null) ? state._vw / 2 : anchorX;
  const anchorTime = xToTime(ax);           // uses current pxPerSec/scroll
  state.pxPerSec = clampZoom(z);
  $('zoom-label').textContent = Math.round(state.pxPerSec) + ' px/s';
  layoutCanvas();
  const target = anchorTime * state.pxPerSec - ax;
  waveScroll.scrollLeft = Math.max(0, Math.min(state.totalW - state._vw, target));
  renderStatic();
  drawPlayhead();
}

$('btn-zoom-in').addEventListener('click', () => setZoom(state.pxPerSec * 1.5));
$('btn-zoom-out').addEventListener('click', () => setZoom(state.pxPerSec / 1.5));

// Mouse wheel over the waveform zooms (anchored at the cursor). Wheel events can
// fire many times per frame (trackpads) and each zoom rebuilds the peak cache,
// so coalesce them into one setZoom per animation frame.
let wheelAccum = 1, wheelAnchorX = 0, wheelQueued = false;
waveCanvas.addEventListener('wheel', (e) => {
  if (!state.buffer) return;
  e.preventDefault();
  const rect = waveCanvas.getBoundingClientRect();
  // normalise delta to pixels (some browsers report lines/pages)
  const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? (state._h || 400) : 1);
  // Alt + wheel scrolls horizontally instead of zooming
  if (e.altKey) {
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
    waveScroll.scrollLeft += d; // fires 'scroll' -> re-render
    return;
  }
  wheelAnchorX = e.clientX - rect.left;
  const dy = e.deltaY * unit;
  wheelAccum *= Math.pow(1.0015, -dy);
  if (wheelQueued) return;
  wheelQueued = true;
  requestAnimationFrame(() => {
    wheelQueued = false;
    setZoom(state.pxPerSec * wheelAccum, wheelAnchorX);
    wheelAccum = 1;
  });
}, { passive: false });

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
        body: JSON.stringify({ beats: state.beats.map((b) => ({ time: b.t, downbeat: !!b.db })) }),
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
$('btn-jump-back').addEventListener('click', () => jumpBars(-1));
$('btn-jump-fwd').addEventListener('click', () => jumpBars(1));
$('btn-prev-section').addEventListener('click', () => jumpSection(-1));
$('btn-next-section').addEventListener('click', () => jumpSection(1));
$('btn-add-section').addEventListener('click', addSectionAtPlayhead);
$('btn-add-chord').addEventListener('click', addChordAtPlayhead);
$('btn-add-beat').addEventListener('click', () => addBeatAt(state.playing ? playPos() : state.currentTime));
$('btn-double-beats').addEventListener('click', doubleBeats);
$('btn-half-beats').addEventListener('click', halveBeats);
$('btn-clear-downbeats').addEventListener('click', () => {
  if (state.beats.some((b) => b.db) && !confirm('Clear all downbeat markings for this song?')) return;
  clearAllDownbeats();
});
$('btn-delete').addEventListener('click', deleteSelected);
$('btn-deselect').addEventListener('click', clearSelection);
$('btn-save').addEventListener('click', save);

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (!state.current) return;
  // Ctrl/Cmd combos (undo, save); ignore others so browser shortcuts work
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undo(); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); save(); }
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  // arrows nudge the selected beat(s): ±20ms, or ±100ms with Shift
  else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSelectedBeats(e.shiftKey ? 0.1 : 0.02); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeSelectedBeats(e.shiftKey ? -0.1 : -0.02); }
  else if (e.key === 'a' || e.key === 'A') { e.preventDefault(); selectBeatsAfterPlayhead(); }
  else if (e.key === 's' || e.key === 'S') { e.preventDefault(); addSectionAtPlayhead(); }
  else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); addChordAtPlayhead(); }
  else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); addBeatAt(state.playing ? playPos() : state.currentTime); }
  else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); doubleBeats(); }
  else if (e.key === 'h' || e.key === 'H') { e.preventDefault(); halveBeats(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  else if (e.key === 'Escape') { e.preventDefault(); clearSelection(); }
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
populateKeySelect();
loadSongs();
