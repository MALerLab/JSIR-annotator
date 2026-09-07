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
const RULER_H = 33;           // top scrub/timeline strip (1.5x)
const STRUCTURE_LANE_H = 33;  // structure-event lane (below the ruler)
const SECTION_LANE_H = 33;    // section-tab lane (below structure)
const CHORD_LANE_H = 33;      // chord lane (below sections, above the waveform)
const LANE_LABEL_W = 66;      // left gutter for the sticky lane labels
const BEAT_HIT_PX = 5;        // click tolerance for selecting/dragging a beat
const LOOKAHEAD = 0.12;       // metronome scheduling lookahead (s)

// Note-name <-> pitch-class maps for chord transposition (mirrors jsd/chords.py,
// with the Ab/G# = 8 fix). Used to transpose lead-sheet progressions into the
// recording's key.
const CHORD_ROOTS = {
  C: 0, Cb: 11, 'C#': 1, D: 2, Db: 1, 'D#': 3, E: 4, Eb: 3, 'E#': 5,
  F: 5, Fb: 4, 'F#': 6, G: 7, Gb: 6, 'G#': 8, A: 9, Ab: 8, 'A#': 10,
  B: 11, Bb: 10, 'B#': 0,
};
const IDX2ROOT = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function rootPrefix(s) {
  if (s.length >= 2 && Object.prototype.hasOwnProperty.call(CHORD_ROOTS, s.slice(0, 2))) {
    return [s.slice(0, 2), CHORD_ROOTS[s.slice(0, 2)]];
  }
  if (s.length >= 1 && Object.prototype.hasOwnProperty.call(CHORD_ROOTS, s.slice(0, 1))) {
    return [s.slice(0, 1), CHORD_ROOTS[s.slice(0, 1)]];
  }
  return [null, null];
}

// Transpose a WJD chord token by `semitones`, preserving quality/extensions and
// transposing the bass of slash chords. '%'/no-chord/unparseable pass through.
function transposeChordToken(tok, semitones) {
  if (!tok || tok === '%' || tok === 'NC' || tok === 'N') return tok;
  const slash = tok.indexOf('/');
  const main = slash >= 0 ? tok.slice(0, slash) : tok;
  const bass = slash >= 0 ? tok.slice(slash + 1) : null;
  const [rstr, rpc] = rootPrefix(main);
  if (rstr === null) return tok;
  let out = IDX2ROOT[((rpc + semitones) % 12 + 12) % 12] + main.slice(rstr.length);
  if (bass !== null) {
    const [bstr, bpc] = rootPrefix(bass);
    out += '/' + (bstr !== null
      ? IDX2ROOT[((bpc + semitones) % 12 + 12) % 12] + bass.slice(bstr.length)
      : bass);
  }
  return out;
}

function keyToPc(k) {
  if (!k) return null;
  const s = String(k);
  let root = (s.includes('-') ? s.split('-')[0] : s.split(' ')[0]).trim();
  return Object.prototype.hasOwnProperty.call(CHORD_ROOTS, root) ? CHORD_ROOTS[root] : null;
}
const SCHED_MS = 25;          // metronome scheduler tick (ms)

const state = {
  songs: [],
  current: null,
  buffer: null,
  duration: 0,
  beats: [],            // [{t, db}] (kept sorted)
  sections: [],         // [{time, name}] (kept sorted)
  structure: [],        // [{time, name}] (kept sorted) — like sections, own lane
  chords: [],           // [{time, chord}] (kept sorted)
  selected: null,       // {kind:'section'|'chord', obj} OR {kind:'beat', obj:<anchor>}
  selBeats: new Set(),  // selected beat objects (source of truth for beats)
  selEvents: new Set(), // selected section/structure/chord objects (multi-select)
  loop: null,           // {start, end} ruler loop/selection region, or null
  undo: null,           // single-level undo snapshot (beats/sections/chords)
  onlyDownbeats: false, // visual: show only downbeat lines on the canvas
  leadsheet: null,      // lead-sheet entry for the current title (or {found:false})
  songVol: 1,           // song gain (0..1.5)
  metroVol: 1,          // metronome gain (0..1)
  beatOpacity: 1,       // opacity of beat lines (0..1); persists across songs
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
        (s.completed ? '<span class="dot" title="completed">●</span>' : '') +
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
  $('panel-fields').innerHTML = songFieldsHtml(song, 'data-field');
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
  $('btn-complete').disabled = false;
  updateCompleteButton($('btn-complete'), song);
  renderLeadsheetInfo();
}

// Shared between the Edit panel and the Library song inspector.
const SONG_META_FIELDS = [
  ['standard', 'Standard', 'text'],
  ['artist', 'Artist', 'text'],
  ['album', 'Album', 'text'],
  ['instrumentation', 'Instrumentation', 'text'],
  ['num_bars', 'Number of Bars', 'number'],
  ['tempo_class', 'Tempo Class', 'text'],
  ['rhythm_feel', 'Rhythm Feel', 'text'],
  ['time_signature', 'Time Signature', 'text'],
  ['yt_id', 'YouTube ID', 'text'],
  ['musicbrainz_id', 'MusicBrainz ID', 'text'],
];
function songFieldsHtml(song, attr) {
  return SONG_META_FIELDS.map(([k, label, type]) => {
    const val = song[k] == null ? '' : song[k];
    const extra = type === 'number' ? ' step="1" min="0"' : '';
    return `<div class="pf"><label>${label}</label>` +
      `<input type="${type}" ${attr}="${k}"${extra} value="${escapeHtml(String(val))}" /></div>`;
  }).join('');
}

// Completion toggle (shared by both tabs).
function updateCompleteButton(btn, song) {
  const done = !!(song && song.completed);
  btn.textContent = done ? 'Mark as incomplete' : 'Mark as complete';
  btn.classList.toggle('is-complete', done);
}
async function toggleCompleted(song) {
  if (!song) return;
  const nv = !song.completed;
  song.completed = nv; // optimistic
  const listed = state.songs.find((x) => x.stem === song.stem);
  if (listed) listed.completed = nv;
  if (state.current && state.current.stem === song.stem) {
    state.current.completed = nv;
    updateCompleteButton($('btn-complete'), state.current);
  }
  renderSongList();
  if (lib.tab === 'library') renderLibrary();
  const ok = await postMetaFields(song.stem, { completed: nv }, null);
  if (!ok) { // revert on failure
    song.completed = !nv;
    if (listed) listed.completed = !nv;
    if (state.current && state.current.stem === song.stem) {
      state.current.completed = !nv;
      updateCompleteButton($('btn-complete'), state.current);
    }
    renderSongList();
    if (lib.tab === 'library') renderLibrary();
  }
}
async function postMetaFields(stem, fields, statusEl) {
  if (statusEl) statusEl.textContent = 'saving…';
  try {
    const r = await fetch(`/api/meta/${stem}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (statusEl) {
      statusEl.textContent = 'saved ✓';
      setTimeout(() => { if (statusEl.textContent === 'saved ✓') statusEl.textContent = ''; }, 1200);
    }
    return true;
  } catch (err) {
    if (statusEl) statusEl.textContent = 'save failed';
    console.error(err);
    return false;
  }
}
$('btn-complete').addEventListener('click', () => { if (state.current) toggleCompleted(state.current); });

function updateYtLink(song) {
  const links = [];
  if (song.yt_id) {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(song.yt_id)}`;
    links.push(`<a href="${url}" target="_blank" rel="noopener">▶ Open on YouTube</a>`);
  }
  if (song.musicbrainz_id) {
    const url = `https://musicbrainz.org/recording/${encodeURIComponent(song.musicbrainz_id)}`;
    links.push(`<a href="${url}" target="_blank" rel="noopener">♪ Open in MusicBrainz</a>`);
  }
  $('panel-yt').innerHTML = links.map((l) => `<div>${l}</div>`).join('');
}

// Fetch the lead-sheet progression for this song's title and show availability.
async function fetchLeadsheet(song) {
  const title = song.standard || '';
  let result = { found: false };
  if (title) {
    try {
      const r = await fetch(`/api/leadsheet?title=${encodeURIComponent(title)}`);
      const d = await r.json();
      if (d && d.found) result = d;
    } catch (e) { /* leave not-found */ }
  }
  if (state.current !== song) return; // user moved on
  state.leadsheet = result;
  renderLeadsheetInfo();
  updateInspector();
}

// Re-pull the lead sheet for the song currently open in the Edit tab. Called
// whenever the Library edits lead-sheet data (or the song's `standard`), so the
// editor's chord-insertion always uses the freshly saved progression.
function syncEditLeadsheet() {
  if (state.current) fetchLeadsheet(state.current);
}

function renderLeadsheetInfo() {
  const el = $('leadsheet-info');
  const ls = state.leadsheet;
  if (ls === null) { el.innerHTML = '<span class="muted">Lead sheet: …</span>'; return; }
  if (!ls.found) { el.innerHTML = '<span class="muted">Lead sheet: none for this title</span>'; return; }
  const bits = [(ls.chord_changes && ls.chord_changes.length) ? 'chords available' : 'no chords'];
  if (ls.coda && ls.coda.length) bits.push('coda available');
  el.innerHTML =
    `<div>Lead sheet: <b>${escapeHtml(ls.key || '—')}</b></div>` +
    `<div class="ls-avail">${escapeHtml(bits.join(' · '))}</div>`;
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
  if (field === 'yt_id' || field === 'musicbrainz_id') updateYtLink(song);
  // time signature changes the default beats-per-measure -> refresh lane/lengths
  if (field === 'time_signature') { scheduleRender(); updateInspector(); }
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
// Beat-line opacity — persists across songs (not reset on load).
function setBeatOpacity(pct) {
  state.beatOpacity = pct / 100;
  $('beat-opacity').value = pct;
  $('beat-opacity-val').textContent = pct + '%';
  scheduleRender();
}
// Reset per-view controls (volumes + downbeats-only) to defaults on song load.
// NOTE: beat opacity intentionally persists across songs.
function resetViewControls() {
  setSongVol(100);
  setMetroVol(100);
  state.onlyDownbeats = false;
  $('chk-only-db').checked = false;
}
$('song-vol').addEventListener('input', (e) => setSongVol(parseInt(e.target.value, 10) || 0));
$('metro-vol').addEventListener('input', (e) => setMetroVol(parseInt(e.target.value, 10) || 0));
$('beat-opacity').addEventListener('input', (e) => setBeatOpacity(parseInt(e.target.value, 10) || 0));
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
  state.selEvents = new Set();
  state.structure = [];
  state.loop = null;
  state.undo = null;
  state.leadsheet = null;
  state.dirty = false;
  state.currentTime = 0;
  resetViewControls();
  renderSongList();
  fetchLeadsheet(song); // async; updates the panel + inspector when it resolves
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
  state.sections = annRes.sections.map((s) => ({ time: s.time, name: s.name, bpm: s.beats_per_measure }));
  state.structure = (annRes.structure || []).map((s) => ({ time: s.time, name: s.name }));
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
  const vw = (waveScroll.clientWidth || 800) - LANE_LABEL_W;  // minus the label gutter
  state.pxPerSec = clampZoom(Math.max(1, vw) / Math.max(1, state.duration));
  $('zoom-label').textContent = Math.round(state.pxPerSec) + ' px/s';
}

function clampZoom(z) {
  return Math.max(4, Math.min(800, z));
}

function enableControls(on) {
  ['btn-play', 'btn-stop', 'btn-jump-back', 'btn-jump-fwd',
   'btn-prev-section', 'btn-next-section', 'btn-add-structure', 'btn-copy-structure',
   'btn-add-section', 'btn-add-chord', 'btn-add-beat', 'btn-double-beats',
   'btn-clear-downbeats', 'btn-delete', 'btn-zoom-in', 'btn-zoom-out', 'btn-save'].forEach((id) => ($(id).disabled = !on));
  // half-beats / deselect depend on the current selection (see updateInspector)
  if (!on) { $('btn-half-beats').disabled = true; $('btn-deselect').disabled = true; }
}

// ----------------------------------------------------------------------------
// Geometry / canvas layout
// ----------------------------------------------------------------------------
const structureLaneTop = () => RULER_H;
const sectionLaneTop = () => RULER_H + STRUCTURE_LANE_H;
const chordLaneTop = () => RULER_H + STRUCTURE_LANE_H + SECTION_LANE_H;
const bodyTop = () => RULER_H + STRUCTURE_LANE_H + SECTION_LANE_H + CHORD_LANE_H;
// The left LANE_LABEL_W px are a reserved gutter for the lane headers: the
// timeline starts there, so nothing is ever drawn underneath the labels.
function tx(t) { return LANE_LABEL_W + t * state.pxPerSec - waveScroll.scrollLeft; }
function xToTime(x) { return (x - LANE_LABEL_W + waveScroll.scrollLeft) / state.pxPerSec; }

function layoutCanvas() {
  const h = waveScroll.clientHeight;
  const vw = waveScroll.clientWidth;
  state.totalW = Math.max(vw, Math.round(state.duration * state.pxPerSec) + LANE_LABEL_W);
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
const STRUCTURE_PALETTE = ['#ff7eb6', '#7ee081', '#4f9dff', '#ffb454', '#56d4d4', '#b78bff'];

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
  wctx.fillStyle = '#0d1017';
  wctx.fillRect(0, structureLaneTop(), vw, STRUCTURE_LANE_H);
  wctx.fillStyle = '#0c0f14';
  wctx.fillRect(0, sectionLaneTop(), vw, SECTION_LANE_H);
  wctx.fillStyle = '#0a0d12';
  wctx.fillRect(0, chordLaneTop(), vw, CHORD_LANE_H);

  // Everything except the lane headers is clipped to the right of the gutter,
  // so the headers never cover timeline content.
  wctx.save();
  wctx.beginPath();
  wctx.rect(LANE_LABEL_W, 0, Math.max(0, vw - LANE_LABEL_W), h);
  wctx.clip();

  drawRuler(vw, scrollLeft);

  drawEventLane(state.structure, structureLaneTop(), STRUCTURE_LANE_H, 'structure', STRUCTURE_PALETTE, structureBars);
  drawEventLane(state.sections, sectionLaneTop(), SECTION_LANE_H, 'section', SECTION_PALETTE, sectionBars);
  drawChords(vw);

  // --- beats (binary-search the visible window, then draw) ---
  const tStart = xToTime(LANE_LABEL_W - 2);
  let i = lowerBound(tStart);
  wctx.globalAlpha = state.beatOpacity; // user-adjustable beat-line opacity
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
  wctx.globalAlpha = 1;

  // --- waveform (read straight from the peak cache) ---
  // Drawn LAST so the audio stays fully readable over the section / structure
  // tints and the beat lines.
  wctx.strokeStyle = '#eef3f8';
  wctx.beginPath();
  const base = Math.floor(scrollLeft) - LANE_LABEL_W;
  for (let x = LANE_LABEL_W; x < vw; x++) {
    const col = base + x;
    if (col < 0 || col >= peakMin.length) continue;
    wctx.moveTo(x + 0.5, mid + peakMin[col] * (bodyH / 2) * 0.95);
    wctx.lineTo(x + 0.5, mid + peakMax[col] * (bodyH / 2) * 0.95);
  }
  wctx.stroke();

  drawLoop(vw, h);
  wctx.restore();
  drawLaneLabels(); // sticky lane headers in the reserved left gutter
}

// Draw one event lane (structure or sections): translucent body fill, coloured
// tab in the lane, full-height start divider, and a name+length label pinned to
// the right of the lane-label gutter when the start scrolls off-screen.
function drawEventLane(events, laneTop, laneH, kind, palette, barsFn) {
  const vw = state._vw, h = state._h, bt = bodyTop(), bodyH = h - bt;
  const sorted = [...events].sort((a, b) => a.time - b.time);
  sorted.forEach((ev, i) => {
    const x0 = tx(ev.time);
    const x1 = tx(eventEnd(events, ev));
    if (x1 < 0 || x0 > vw) return;
    const col = palette[i % palette.length];
    wctx.fillStyle = hexA(col, 0.065);   // faint body tint (kept light so the wave reads)
    wctx.fillRect(x0, bt, x1 - x0, bodyH);
    const selected = state.selEvents.has(ev);
    wctx.fillStyle = selected ? col : hexA(col, 0.5);
    wctx.fillRect(x0, laneTop, Math.max(2, x1 - x0), laneH);
    wctx.strokeStyle = col;
    wctx.lineWidth = selected ? 2 : 1;
    wctx.beginPath();
    wctx.moveTo(x0 + 0.5, laneTop);
    wctx.lineTo(x0 + 0.5, h);
    wctx.stroke();
    // label pinned after the lane-label gutter (kept clear of lane headers)
    const label = `${ev.name || '(unnamed)'}  ·  ${fmtBars(barsFn(ev))}`;
    const clipL = Math.max(x0, LANE_LABEL_W);
    wctx.fillStyle = '#0e1116';
    wctx.font = '11px system-ui, sans-serif';
    wctx.textBaseline = 'middle';
    wctx.save();
    wctx.beginPath();
    wctx.rect(clipL + 2, laneTop, Math.max(0, x1 - clipL - 4), laneH);
    wctx.clip();
    wctx.fillText(label, Math.max(x0 + 6, LANE_LABEL_W + 4), laneTop + laneH / 2 + 1);
    wctx.restore();
  });
}

// Left-edge headers for the timeline lanes. They live in a reserved gutter
// (the timeline itself starts at LANE_LABEL_W), so they cover no content.
function drawLaneLabels() {
  const h = state._h;
  const lanes = [
    ['Structure', structureLaneTop(), STRUCTURE_LANE_H],
    ['Sections', sectionLaneTop(), SECTION_LANE_H],
    ['Chords', chordLaneTop(), CHORD_LANE_H],
    ['Audio', bodyTop(), CHORD_LANE_H],
  ];
  // one continuous gutter column down the whole canvas
  wctx.fillStyle = '#0b0e13';
  wctx.fillRect(0, 0, LANE_LABEL_W, h);
  wctx.strokeStyle = '#2d343d';
  wctx.lineWidth = 1;
  wctx.beginPath();
  wctx.moveTo(LANE_LABEL_W + 0.5, 0);
  wctx.lineTo(LANE_LABEL_W + 0.5, h);
  wctx.stroke();
  wctx.font = '10px system-ui, sans-serif';
  wctx.textBaseline = 'middle';
  for (const [text, top, laneH] of lanes) {
    wctx.strokeStyle = '#2d343d';
    wctx.beginPath();
    wctx.moveTo(0, top + 0.5);
    wctx.lineTo(LANE_LABEL_W, top + 0.5);
    wctx.stroke();
    wctx.fillStyle = '#8b96a3';
    wctx.fillText(text, 7, top + laneH / 2 + 1);
  }
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
  for (const yy of [RULER_H, sectionLaneTop(), chordLaneTop(), bodyTop()]) {
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
    const selected = state.selEvents.has(ch);
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
      const cx = Math.max(x0, LANE_LABEL_W);   // keep clear of the "Chords" gutter
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

// An event runs until the next one in its own list, or the end of the track.
function eventEnd(list, ev) {
  let end = state.duration;
  for (const s of list) if (s.time > ev.time && s.time < end) end = s.time;
  return end;
}
// The song's default beats-per-measure = numerator of its time signature (4/4→4).
function songBeatsPerMeasure() {
  const ts = state.current && state.current.time_signature;
  const n = ts ? parseInt(String(ts).split('/')[0], 10) : NaN;
  return (n && n > 0) ? n : 4;
}
// A section's beats-per-measure = its explicit override, else the song default.
function sectionBeatsPerMeasure(sec) {
  return (sec && sec.bpm > 0) ? sec.bpm : songBeatsPerMeasure();
}
// Event length in bars = beats within the event / beats-per-measure.
function eventBars(list, ev, bpm) {
  const startIdx = lowerBound(ev.time - 1e-9);
  const endIdx = lowerBound(eventEnd(list, ev) - 1e-9);
  return Math.max(0, endIdx - startIdx) / (bpm > 0 ? bpm : 4);
}
function sectionEnd(sec) { return eventEnd(state.sections, sec); }
function sectionBars(sec) { return eventBars(state.sections, sec, sectionBeatsPerMeasure(sec)); }
// structure has no per-event bpm — it uses the song default.
function structureBars(ev) { return eventBars(state.structure, ev, songBeatsPerMeasure()); }
function fmtBars(bars) {
  const s = Number.isInteger(bars) ? String(bars) : bars.toFixed(2).replace(/\.?0+$/, '');
  return `${s} bar${bars === 1 ? '' : 's'}`;
}

// ----------------------------------------------------------------------------
// Chord-progression insertion (from lead_sheet_chords.json)
// ----------------------------------------------------------------------------
// Flatten bar strings ("F-7 % % %") into a per-beat token list.
function flattenChanges(changes) {
  const out = [];
  for (const bar of changes || []) {
    for (const t of String(bar).trim().split(/\s+/)) if (t) out.push(t);
  }
  return out;
}
// Number of beat tokens per bar in a progression (from the first bar).
function barTokenCount(bars) {
  return (bars && bars.length) ? String(bars[0]).trim().split(/\s+/).length : 4;
}
// Distinct consecutive (non-%) chords in a bar: "G-7 % C7 %" -> ["G-7","C7"].
function distinctChordsInBar(bar) {
  const out = [];
  for (const tok of String(bar).trim().split(/\s+/)) {
    if (!tok || tok === '%') continue;
    if (out.length && out[out.length - 1] === tok) continue; // collapse repeats
    out.push(tok);
  }
  return out;
}
// Beat positions (0-indexed) for `c` chords within a `bpm`-beat measure.
// bpm=3: 1->[0], 2->[0,2], 3->[0,1,2], 4->[0,1,2] (first three).
function placeInMeasure(c, bpm) {
  if (c <= 0) return [];
  if (c >= bpm) return Array.from({ length: bpm }, (_, k) => k);
  const pos = [];
  for (let k = 0; k < c; k++) pos.push(Math.round((k * bpm) / c));
  return pos;
}
// Walk back from `idx` (looping) to the last real chord token — the chord that
// is sounding at a beat that maps to a '%' hold.
function resolveHeldToken(prog, idx) {
  for (let k = 0; k < prog.length; k++) {
    const j = ((idx - k) % prog.length + prog.length) % prog.length;
    if (prog[j] !== '%') return prog[j];
  }
  return null;
}
function sectionBeatsIn(sec) {
  const start = sec.time, end = sectionEnd(sec);
  return state.beats
    .filter((b) => b.t >= start - 1e-9 && b.t < end - 1e-9)
    .sort((a, b) => a.t - b.t);
}
// Semitone shift to transpose lead-sheet chords into the recording's key.
function insertSemitones() {
  if (!$('ins-transpose').checked) return 0;
  const rec = keyToPc(state.current && state.current.key);
  const ls = state.leadsheet ? keyToPc(state.leadsheet.key) : null;
  if (rec === null || ls === null) return 0; // can't compare -> no transpose
  return ((rec - ls) % 12 + 12) % 12;
}
// Map progression beats onto the section's beats (looping), starting at
// progression index `startOffset`, overwriting existing chords in the region.
function insertProgression(sec, prog, startOffset) {
  if (!prog.length) return;
  const secBeats = sectionBeatsIn(sec);
  if (!secBeats.length) { flashStatus('no beats in this section'); return; }
  const semis = insertSemitones();
  const start = sec.time, end = sectionEnd(sec);
  pushUndo();
  // overwrite existing chord events whose start falls in the section region
  state.chords = state.chords.filter((c) => !(c.time >= start - 1e-9 && c.time < end - 1e-9));
  let count = 0;
  for (let i = 0; i < secBeats.length; i++) {
    const idx = ((startOffset + i) % prog.length + prog.length) % prog.length;
    let tok = prog[idx];
    if (i === 0 && tok === '%') tok = resolveHeldToken(prog, idx); // establish the held chord
    if (!tok || tok === '%') continue;
    const name = (tok === 'NC' || tok === 'N') ? 'N.C.'
      : (semis ? transposeChordToken(tok, semis) : tok);
    state.chords.push({ time: secBeats[i].t, chord: name });
    count++;
  }
  state.chords.sort((a, b) => a.time - b.time);
  markDirty();
  scheduleRender();
  updateInspector();
  flashStatus(`inserted ${count} chords${semis ? ` (transposed +${semis})` : ''}`);
}

// Measure-based insertion, used when the section's beats-per-measure differs
// from the progression's beats-per-bar (e.g. a 3-beat section against 4/4 bars).
// For each section measure, the matching progression bar's distinct chords are
// fitted into the measure's beats via placeInMeasure(). `startBarOffset` is the
// progression bar index that the section's first measure maps to.
function insertProgressionMeasures(sec, bars, startBarOffset) {
  if (!bars.length) return;
  const secBeats = sectionBeatsIn(sec);
  if (!secBeats.length) { flashStatus('no beats in this section'); return; }
  const bpm = sectionBeatsPerMeasure(sec);
  const semis = insertSemitones();
  const start = sec.time, end = sectionEnd(sec);
  pushUndo();
  state.chords = state.chords.filter((c) => !(c.time >= start - 1e-9 && c.time < end - 1e-9));
  let count = 0;
  const numMeasures = Math.ceil(secBeats.length / bpm);
  for (let m = 0; m < numMeasures; m++) {
    const mBeats = secBeats.slice(m * bpm, (m + 1) * bpm);
    const barIdx = ((startBarOffset + m) % bars.length + bars.length) % bars.length;
    const chords = distinctChordsInBar(bars[barIdx]);
    const positions = placeInMeasure(chords.length, bpm);
    for (let k = 0; k < positions.length && k < chords.length; k++) {
      const pos = positions[k];
      if (pos >= mBeats.length) continue;
      const tok = chords[k];
      const name = (tok === 'NC' || tok === 'N') ? 'N.C.'
        : (semis ? transposeChordToken(tok, semis) : tok);
      state.chords.push({ time: mBeats[pos].t, chord: name });
      count++;
    }
  }
  state.chords.sort((a, b) => a.time - b.time);
  markDirty();
  scheduleRender();
  updateInspector();
  flashStatus(`inserted ${count} chords${semis ? ` (transposed +${semis})` : ''}`);
}
function flashStatus(msg) { setStatus(msg); setTimeout(() => setStatus(''), 2000); }

function currentSection() {
  return (state.selected && state.selected.kind === 'section') ? state.selected.obj : null;
}
// Choose beat-level (aligned) vs measure-based (count rule) insertion by comparing
// the section's beats-per-measure to the progression's beats-per-bar.
function insertChords() {
  const s = currentSection(), ls = state.leadsheet;
  if (!s || !ls || !ls.found) return;
  const bars = ls.chord_changes;
  if (sectionBeatsPerMeasure(s) === barTokenCount(bars)) insertProgression(s, flattenChanges(bars), 0);
  else insertProgressionMeasures(s, bars, 0);
}
function insertLast() {
  const s = currentSection(), ls = state.leadsheet;
  if (!s || !ls || !ls.found) return;
  const bars = ls.chord_changes;
  const bpm = sectionBeatsPerMeasure(s);
  if (bpm === barTokenCount(bars)) {
    const prog = flattenChanges(bars);
    insertProgression(s, prog, prog.length - sectionBeatsIn(s).length); // beat-level back-align
  } else {
    const numMeasures = Math.ceil(sectionBeatsIn(s).length / bpm);
    insertProgressionMeasures(s, bars, bars.length - numMeasures); // measure-level back-align
  }
}
function insertCoda() {
  const s = currentSection(), ls = state.leadsheet;
  if (!s || !ls || !ls.coda || !ls.coda.length) return;
  const bars = ls.coda;
  if (sectionBeatsPerMeasure(s) === barTokenCount(bars)) insertProgression(s, flattenChanges(bars), 0);
  else insertProgressionMeasures(s, bars, 0);
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
  if (x < LANE_LABEL_W || x > vw + 1) return;  // hidden behind the lane gutter
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
  if (x < LANE_LABEL_W + 60 || x > state._vw - 60) {
    const target = playPos() * state.pxPerSec + LANE_LABEL_W - state._vw * 0.5;
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

// Re-grid downbeats for every beat in [startTime, endTime): the beat nearest
// startTime becomes a downbeat, then every `bpm`-th beat after it; all other
// beats in that range are forced off. Beats outside the range are untouched.
// endTime defaults to the end of the track (used when a section is created).
function applyDownbeatGrid(startTime, bpm, endTime) {
  if (!state.beats.length) return;
  bpm = bpm > 0 ? bpm : 4;
  endTime = endTime == null ? Infinity : endTime;
  let startIdx = 0, bd = Infinity;
  for (let i = 0; i < state.beats.length; i++) {
    const d = Math.abs(state.beats[i].t - startTime);
    if (d < bd) { bd = d; startIdx = i; }
  }
  for (let i = startIdx; i < state.beats.length; i++) {
    if (state.beats[i].t >= endTime - 1e-9) break;
    state.beats[i].db = ((i - startIdx) % bpm) === 0;
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
// Section/structure/chord selection lives in state.selEvents (a Set); state.selected
// mirrors the anchor (last object) so single-event editing keeps working.
function eventListFor(kind) {
  return kind === 'section' ? state.sections : kind === 'structure' ? state.structure : state.chords;
}
function setEventSelection(kind, arr) {
  state.selBeats = new Set();
  state.selEvents = new Set(arr);
  state.selected = arr.length ? { kind, obj: arr[arr.length - 1] } : null;
}
function selectSectionObj(s) { setEventSelection('section', [s]); }
function selectStructureObj(s) { setEventSelection('structure', [s]); }
function selectChordObj(c) { setEventSelection('chord', [c]); }
// A-select: with an event selected, select all of that kind at/after the
// earliest currently-selected one (inclusive).
function selectEventsAfter(kind) {
  const list = eventListFor(kind);
  let t0 = Infinity;
  for (const e of state.selEvents) t0 = Math.min(t0, e.time);
  if (!isFinite(t0) && state.selected) t0 = state.selected.obj.time;
  if (!isFinite(t0)) return;
  const arr = list.filter((e) => e.time >= t0 - 1e-9).sort((a, b) => a.time - b.time);
  setEventSelection(kind, arr);
  scheduleRender();
  updateInspector();
  setStatus(`selected ${arr.length} ${kind}${arr.length === 1 ? '' : (kind === 'structure' ? '' : 's')}`);
  setTimeout(() => setStatus(''), 1200);
}

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
  if (!state.selected && !state.selBeats.size && !state.selEvents.size) return;
  state.selBeats = new Set();
  state.selEvents = new Set();
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
    sections: state.sections.map((s) => ({ time: s.time, name: s.name, bpm: s.bpm })),
    structure: state.structure.map((s) => ({ time: s.time, name: s.name })),
    chords: state.chords.map((c) => ({ time: c.time, chord: c.chord })),
  };
}
function pushUndo() { state.undo = snapshotState(); }
function restoreSnapshot(snap) {
  state.beats = snap.beats.map((b) => ({ t: b.t, db: b.db }));
  state.sections = snap.sections.map((s) => ({ time: s.time, name: s.name, bpm: s.bpm }));
  state.structure = (snap.structure || []).map((s) => ({ time: s.time, name: s.name }));
  state.chords = snap.chords.map((c) => ({ time: c.time, chord: c.chord }));
  state.selBeats = new Set();
  state.selEvents = new Set();
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
// Subdivide the gap between each consecutive pair of selected beats into `parts`
// (default 4) by inserting `parts - 1` evenly-spaced beats.
function fillSelectedBeats(parts) {
  parts = parts > 1 ? parts : 4;
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
    for (let k = 1; k < parts; k++) additions.push({ t: a + (b - a) * (k / parts), db: false });
  }
  state.beats.push(...additions);
  resortBeats();
  if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  markDirty();
  scheduleRender();
  updateInspector();
  setStatus(`filled ÷${parts} → +${additions.length} beats`);
  setTimeout(() => setStatus(''), 1500);
}

// Ctrl+D: toggle downbeat for the selected beats as a group (all-on if any are
// off, else all-off).
function toggleDownbeatSelection() {
  if (!state.selBeats.size) return;
  pushUndo();
  const allDb = [...state.selBeats].every((b) => b.db);
  for (const b of state.selBeats) b.db = !allDb;
  markDirty();
  scheduleRender();
  updateInspector();
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
    // from this section's start, re-grid downbeats every N beats (N = its bpm)
    applyDownbeatGrid(t, sectionBeatsPerMeasure(sec));
    markDirty();
  }
  state.selEvents = new Set([state.selected.obj]);
  scheduleRender();
  updateInspector();
}

// Like addSectionAtPlayhead, but for the structure lane (no downbeat re-grid).
function addStructureAtPlayhead() {
  const raw = state.playing ? playPos() : state.currentTime;
  const t = snapToBeat(raw);
  state.selBeats = new Set();
  const existing = state.structure.find((s) => Math.abs(s.time - t) < 1e-3);
  if (existing) {
    state.selected = { kind: 'structure', obj: existing };
  } else {
    pushUndo();
    const ev = { time: t, name: `structure ${state.structure.length + 1}` };
    state.structure.push(ev);
    state.structure.sort((a, b) => a.time - b.time);
    state.selected = { kind: 'structure', obj: ev };
    markDirty();
  }
  state.selEvents = new Set([state.selected.obj]);
  scheduleRender();
  updateInspector();
}

// Copy every section (name + position) into the structure lane, making the two
// timelines identical. (Ctrl+T)
function copySectionsToStructure() {
  if (!state.current) return;
  pushUndo();
  state.structure = state.sections.map((s) => ({ time: s.time, name: s.name }));
  state.selBeats = new Set();
  state.selEvents = new Set();
  state.selected = null;
  markDirty();
  scheduleRender();
  updateInspector();
  setStatus(`copied ${state.structure.length} sections → structure`);
  setTimeout(() => setStatus(''), 1500);
}

// Re-grid downbeats within the selected section only (every N beats, N = its bpm).
function insertSectionDownbeats() {
  const s = currentSection();
  if (!s) return;
  pushUndo();
  applyDownbeatGrid(s.time, sectionBeatsPerMeasure(s), sectionEnd(s));
  if (state.playing) state.nextBeatIdx = lowerBound(playPos());
  markDirty();
  scheduleRender();
  updateInspector();
  setStatus('inserted downbeats for section');
  setTimeout(() => setStatus(''), 1500);
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
  state.selEvents = new Set([state.selected.obj]);
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
  } else if (state.selEvents.size && state.selected) {
    pushUndo();
    const kind = state.selected.kind;
    const del = state.selEvents;
    if (kind === 'section') state.sections = state.sections.filter((s) => !del.has(s));
    else if (kind === 'structure') state.structure = state.structure.filter((s) => !del.has(s));
    else if (kind === 'chord') state.chords = state.chords.filter((c) => !del.has(c));
    state.selEvents = new Set();
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
  $('inspector-multi').classList.add('hidden');
  $('inspector-section').classList.add('hidden');
  $('inspector-structure').classList.add('hidden');
  $('inspector-chord').classList.add('hidden');
  const nBeats = state.selBeats.size;
  const nEvents = state.selEvents.size;
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

  if (nEvents > 1 && state.selected) {
    // multi section/structure/chord group inspector
    const kind = state.selected.kind;
    const noun = kind === 'structure' ? 'structure events' : (kind + 's');
    $('inspector-multi').classList.remove('hidden');
    $('multi-title').textContent = kind.charAt(0).toUpperCase() + kind.slice(1) + ' (multiple)';
    $('multi-count').textContent = `${nEvents} ${noun}`;
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
  } else if (state.selected.kind === 'structure') {
    $('inspector-structure').classList.remove('hidden');
    const s = state.selected.obj;
    if (document.activeElement !== $('structure-name')) $('structure-name').value = s.name;
    $('structure-time').value = s.time.toFixed(3);
    $('structure-end').textContent = eventEnd(state.structure, s).toFixed(3) + ' s';
    $('structure-bars').textContent = fmtBars(structureBars(s));
  } else {
    $('inspector-section').classList.remove('hidden');
    const s = state.selected.obj;
    // don't stomp what the user is actively typing in the name combobox
    if (document.activeElement !== $('section-name')) $('section-name').value = s.name;
    $('section-time').value = s.time.toFixed(3);
    $('section-end').textContent = sectionEnd(s).toFixed(3) + ' s';
    $('section-bars').textContent = fmtBars(sectionBars(s));
    if (document.activeElement !== $('section-bpm')) $('section-bpm').value = sectionBeatsPerMeasure(s);

    // chord-insertion button availability
    const ls = state.leadsheet;
    const bpm = sectionBeatsPerMeasure(s);
    const hasChanges = !!(ls && ls.found && ls.chord_changes && ls.chord_changes.length);
    const numBars = hasChanges ? ls.chord_changes.length : 0;
    const secBeats = sectionBeatsIn(s).length;
    const secMeasures = Math.ceil(secBeats / bpm);
    $('ins-chords').disabled = !(hasChanges && secBeats > 0);
    // "Insert last" only when the section is shorter than the lead sheet
    $('ins-last').disabled = !(hasChanges && secBeats > 0 && secMeasures < numBars);
    $('ins-coda').disabled = !(ls && ls.found && ls.coda && ls.coda.length && secBeats > 0);
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
$('beats-fill').addEventListener('click', () => fillSelectedBeats(4));
$('beats-delete').addEventListener('click', deleteSelected);
$('multi-delete').addEventListener('click', deleteSelected);

// --- name combobox factory (preset dropdown + autocomplete) ----------------
// Shared by the section and structure name fields.
const SECTION_PRESETS = [
  'intro',
  'head:horn', 'head:piano', 'head:vocal', 'head:guitar',
  'solo:horn', 'solo:piano', 'solo:bass', 'solo:guitar', 'solo:drum',
  'last', 'trade', 'exclude', 'interlude', 'outro'
];

function setupNameCombo(inputId, listId, kind) {
  const input = $(inputId), list = $(listId);
  let active = -1;
  const getObj = () =>
    (state.selected && state.selected.kind === kind) ? state.selected.obj : null;
  const setName = (val) => {
    const o = getObj();
    if (!o) return;
    o.name = val;
    markDirty();
    scheduleRender();
  };
  function show() {
    const q = input.value.toLowerCase();
    const items = SECTION_PRESETS.filter((p) => p.toLowerCase().includes(q));
    active = -1;
    if (!items.length) { list.classList.add('hidden'); list.innerHTML = ''; return; }
    list.innerHTML = items.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
    list.classList.remove('hidden');
  }
  function hide() { list.classList.add('hidden'); active = -1; }
  function highlight(delta) {
    const lis = list.querySelectorAll('li');
    if (!lis.length) return;
    active = (active + delta + lis.length) % lis.length;
    lis.forEach((li, i) => li.classList.toggle('active', i === active));
  }
  function apply(val) { input.value = val; setName(val); }

  input.addEventListener('input', () => { setName(input.value); show(); });
  input.addEventListener('focus', show);
  input.addEventListener('mousedown', () => setTimeout(show, 0));
  input.addEventListener('keydown', (e) => {
    const open = !list.classList.contains('hidden');
    if (e.key === 'ArrowDown') { e.preventDefault(); open ? highlight(1) : show(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const lis = list.querySelectorAll('li');
      if (open && active >= 0 && lis[active]) apply(lis[active].textContent);
      hide();
      input.blur(); // hand focus back so shortcuts work
    } else if (e.key === 'Escape') { hide(); }
  });
  input.addEventListener('blur', () => setTimeout(hide, 150));
  // mousedown fires before the input's blur, so the click always registers
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    apply(li.textContent);
    hide();
    input.blur();
  });
}
setupNameCombo('section-name', 'section-presets', 'section');
setupNameCombo('structure-name', 'structure-presets', 'structure');
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
$('section-bpm').addEventListener('change', (e) => {
  if (!state.selected || state.selected.kind !== 'section') return;
  const v = parseInt(e.target.value, 10);
  pushUndo();
  state.selected.obj.bpm = (v > 0) ? v : undefined; // blank/invalid -> song default
  markDirty();
  scheduleRender();
  updateInspector();
});
$('section-downbeats').addEventListener('click', insertSectionDownbeats);
$('ins-chords').addEventListener('click', insertChords);
$('ins-last').addEventListener('click', insertLast);
$('ins-coda').addEventListener('click', insertCoda);
$('ins-transpose').addEventListener('change', (e) => e.target.blur());

$('structure-time').addEventListener('change', (e) => {
  if (!state.selected || state.selected.kind !== 'structure') return;
  const v = parseFloat(e.target.value);
  if (!isNaN(v)) {
    pushUndo();
    state.selected.obj.time = Math.max(0, Math.min(state.duration, v));
    state.structure.sort((a, b) => a.time - b.time);
    markDirty();
    scheduleRender();
    updateInspector();
  }
});
$('structure-snap').addEventListener('click', () => {
  if (!state.selected || state.selected.kind !== 'structure') return;
  pushUndo();
  state.selected.obj.time = snapToBeat(state.selected.obj.time);
  state.structure.sort((a, b) => a.time - b.time);
  markDirty();
  scheduleRender();
  updateInspector();
});
$('structure-delete').addEventListener('click', deleteSelected);

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
  if (x < LANE_LABEL_W) return;   // reserved lane-label gutter
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

  // Structure lane -> select / drag a structure event, else deselect
  if (y < sectionLaneTop()) {
    const ev = eventAtX(state.structure, x);
    if (ev) {
      selectStructureObj(ev);
      drag = { kind: 'structure', obj: ev };
      waveCanvas.setPointerCapture(e.pointerId);
      scheduleRender();
      updateInspector();
    } else {
      clearSelection();
    }
    return;
  }

  // Section lane -> select / drag a section, else deselect
  if (y < chordLaneTop()) {
    const sec = eventAtX(state.sections, x);
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
  if (x < LANE_LABEL_W + EDGE_ZONE) return -Math.min(1, (LANE_LABEL_W + EDGE_ZONE - x) / EDGE_ZONE) * EDGE_MAX_PX;
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
    waveCanvas.style.cursor =
      x < LANE_LABEL_W ? 'default' : (y < RULER_H ? 'ew-resize' : 'crosshair');
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
  } else if (drag.kind === 'structure') {
    drag.obj.time = snapToBeat(drag.obj.time);
    state.structure.sort((a, b) => a.time - b.time);
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

function eventAtX(list, x) {
  let found = null;
  for (const s of list) {
    if (x >= tx(s.time) && x < tx(eventEnd(list, s))) found = s;
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
  const target = anchorTime * state.pxPerSec + LANE_LABEL_W - ax;
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
        body: JSON.stringify({ sections: state.sections.map((s) => ({ time: s.time, name: s.name, beats_per_measure: s.bpm })) }),
      }),
      fetch(`/api/structure/${stem}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ structure: state.structure }),
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
$('btn-add-structure').addEventListener('click', addStructureAtPlayhead);
$('btn-copy-structure').addEventListener('click', copySectionsToStructure);
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
  if (lib.tab !== 'edit') return; // editor shortcuts only apply on the Edit tab
  if (!state.current) return;
  // Ctrl/Cmd combos (undo, save, toggle downbeat); ignore others
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undo(); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); save(); }
    else if (e.code === 'KeyD') { e.preventDefault(); toggleDownbeatSelection(); }
    return;
  }
  // Alt combos (insert chords for the selected section)
  if (e.altKey) {
    if (e.code === 'KeyC') {
      e.preventDefault();
      if (state.selected && state.selected.kind === 'section') insertChords();
    }
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  // arrows nudge the selected beat(s): ±20ms, or ±100ms with Shift
  else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSelectedBeats(e.shiftKey ? 0.1 : 0.02); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeSelectedBeats(e.shiftKey ? -0.1 : -0.02); }
  // A: with an event selected -> select all following of that kind; else beats
  else if (e.key === 'a' || e.key === 'A') {
    e.preventDefault();
    if (state.selected && ['section', 'structure', 'chord'].includes(state.selected.kind)) {
      selectEventsAfter(state.selected.kind);
    } else {
      selectBeatsAfterPlayhead();
    }
  }
  else if (e.key === 's' || e.key === 'S') { e.preventDefault(); addSectionAtPlayhead(); }
  else if (e.key === 't' || e.key === 'T') { e.preventDefault(); addStructureAtPlayhead(); }
  else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); copySectionsToStructure(); }
  else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); addChordAtPlayhead(); }
  else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); addBeatAt(state.playing ? playPos() : state.currentTime); }
  else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); doubleBeats(); }
  else if (e.key === 'h' || e.key === 'H') { e.preventDefault(); halveBeats(); }
  // Q/E jump backward/forward N bars; J/K jump to prev/next section
  else if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); jumpBars(-1); }
  else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); jumpBars(1); }
  else if (e.key === 'j' || e.key === 'J') { e.preventDefault(); jumpSection(-1); }
  else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); jumpSection(1); }
  // 2/3/4 subdivide the gaps between selected beats into 2/3/4 parts
  else if (e.key === '2') { e.preventDefault(); fillSelectedBeats(2); }
  else if (e.key === '3') { e.preventDefault(); fillSelectedBeats(3); }
  else if (e.key === '4') { e.preventDefault(); fillSelectedBeats(4); }
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

// ============================================================================
// LIBRARY TAB
// ============================================================================
const lib = {
  tab: 'library',       // 'library' | 'edit'
  leadsheets: [],       // [{...entry, index}]
  selectedLs: null,     // lead-sheet index, or null
  selectedSong: null,   // song stem, or null
  refreshBusy: false,
};

// ---- tabs ------------------------------------------------------------------
function setTab(name) {
  lib.tab = name;
  $('library').classList.toggle('hidden', name !== 'library');
  $('app').classList.toggle('hidden', name !== 'edit');
  $('tab-library').classList.toggle('active', name === 'library');
  $('tab-edit').classList.toggle('active', name === 'edit');
  if (name === 'edit' && state.buffer) {
    // dimensions may be stale after being hidden / window resizes
    layoutCanvas(); renderStatic(); drawPlayhead();
    // pick up metadata / lead-sheet edits made on the Library side
    if (state.current) renderSongPanel(state.current);
    syncEditLeadsheet();
  }
  if (name === 'library') renderLibrary();
}
$('tab-library').addEventListener('click', () => setTab('library'));
$('tab-edit').addEventListener('click', () => setTab('edit'));

// ---- data ------------------------------------------------------------------
async function loadLeadsheets() {
  try {
    lib.leadsheets = await (await fetch('/api/leadsheets')).json();
  } catch (err) {
    lib.leadsheets = [];
    console.error(err);
  }
}
function currentLs() {
  return lib.selectedLs != null
    ? lib.leadsheets.find((x) => x.index === lib.selectedLs) || null : null;
}
function currentLibSong() {
  return state.songs.find((s) => s.stem === lib.selectedSong) || null;
}
function lsCpm(e) {
  if (e.chords_per_measure > 0) return e.chords_per_measure;
  const n = parseInt(String(e.signature || '').split('/')[0], 10);
  return n > 0 ? n : 4;
}
function fmtDur(secs) {
  secs = Math.round(secs || 0);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return `${h}h ${m}m ${s}s`;
}
function keyOptionsHtml(sel) {
  let h = `<option value=""${!sel ? ' selected' : ''}>None</option>`;
  for (const [mode, label] of [['major', 'Major'], ['minor', 'Minor']]) {
    h += `<optgroup label="${label}">`;
    for (const r of KEY_ROOTS) {
      const v = `${r} ${mode}`;
      h += `<option value="${v}"${v === sel ? ' selected' : ''}>${v}</option>`;
    }
    h += '</optgroup>';
  }
  return h;
}

// ---- rendering -------------------------------------------------------------
function renderLibrary() {
  renderLibLists();
  renderLibInspector();
}

function renderLibLists() {
  // lead sheets
  const lsq = $('lib-ls-filter').value.toLowerCase();
  const lu = $('lib-ls-list');
  lu.innerHTML = '';
  lib.leadsheets
    .filter((e) => (e.title || '').toLowerCase().includes(lsq))
    .forEach((e) => {
      const li = document.createElement('li');
      if (lib.selectedLs === e.index) li.classList.add('active');
      const bars = (e.chord_changes || []).length;
      li.innerHTML =
        `<div class="t">${escapeHtml(e.title || '(untitled)')}</div>` +
        `<div class="a">${escapeHtml(e.key || '—')} · ${bars} bars${e.coda ? ' · coda' : ''}</div>`;
      li.onclick = () => {
        lib.selectedLs = (lib.selectedLs === e.index) ? null : e.index;
        lib.selectedSong = null;
        renderLibrary();
      };
      lu.appendChild(li);
    });

  // songs (filtered by the selected lead sheet's title, lower-cased)
  const sq = $('lib-song-filter').value.toLowerCase();
  const selLs = currentLs();
  const selTitle = selLs ? (selLs.title || '').trim().toLowerCase() : null;
  const su = $('lib-song-list');
  su.innerHTML = '';
  state.songs
    .filter((s) => selTitle == null || (s.standard || '').trim().toLowerCase() === selTitle)
    .filter((s) =>
      [s.standard, s.artist, s.album].filter(Boolean).join(' ').toLowerCase().includes(sq))
    .forEach((s) => {
      const li = document.createElement('li');
      if (lib.selectedSong === s.stem) li.classList.add('active');
      li.innerHTML =
        `<div class="t">${escapeHtml(s.standard || '(untitled)')}` +
        (s.completed ? '<span class="dot" title="completed">●</span>' : '') +
        `</div><div class="a">${escapeHtml(s.artist || '')}</div>`;
      li.onclick = () => {
        lib.selectedSong = (lib.selectedSong === s.stem) ? null : s.stem;
        renderLibrary();
      };
      su.appendChild(li);
    });
}
$('lib-ls-filter').addEventListener('input', renderLibLists);
$('lib-song-filter').addEventListener('input', renderLibLists);

function renderLibInspector() {
  $('lib-stats').classList.add('hidden');
  $('lib-ls-info').classList.add('hidden');
  $('lib-song-info').classList.add('hidden');
  const song = currentLibSong();
  const ls = currentLs();
  if (song) renderLibSongInfo(song);
  else if (ls) renderLsInfo(ls);
  else renderLibStats();
}

function renderLibStats() {
  $('lib-stats').classList.remove('hidden');
  const songs = state.songs;
  const done = songs.filter((s) => s.completed);
  const total = songs.reduce((a, s) => a + (s.audio_length || 0), 0);
  const doneDur = done.reduce((a, s) => a + (s.audio_length || 0), 0);
  $('stats-list').innerHTML = [
    ['Lead sheets', String(lib.leadsheets.length)],
    ['Songs', String(songs.length)],
    ['Completion', `${done.length} / ${songs.length}`],
    ['Total audio', fmtDur(total)],
    ['Completed audio', fmtDur(doneDur)],
  ].map(([k, v]) => `<div class="row"><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');
}

// ---- lead sheet inspector --------------------------------------------------
const LS_FIELDS = [
  ['title', 'Title'],
  ['key', 'Key'],
  ['signature', 'Time Signature'],
  ['tempoclass', 'Tempo Class'],
  ['rhythmfeel', 'Rhythm Feel'],
];

function renderLsInfo(e) {
  $('lib-ls-info').classList.remove('hidden');
  $('ls-fields').innerHTML = LS_FIELDS.map(([k, label]) =>
    `<div class="pf"><label>${label}</label>` +
    `<input type="text" data-lsfield="${k}" value="${escapeHtml(String(e[k] == null ? '' : e[k]))}" /></div>`
  ).join('');
  $('ls-cpm').value = lsCpm(e);
  renderChordGrid($('ls-grid'), e.chord_changes || [], lsCpm(e), 'chord_changes');
  const hasCoda = Array.isArray(e.coda);
  $('ls-add-coda').classList.toggle('hidden', hasCoda);
  $('ls-coda-grid').classList.toggle('hidden', !hasCoda);
  $('ls-del-coda').classList.toggle('hidden', !hasCoda);
  if (hasCoda) renderChordGrid($('ls-coda-grid'), e.coda, lsCpm(e), 'coda');
}

async function saveLsFields(fields) {
  const e = currentLs();
  if (!e) return false;
  $('ls-status').textContent = 'saving…';
  try {
    const r = await fetch(`/api/leadsheets/${e.index}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    syncEditLeadsheet();   // keep the Edit tab's working copy in step
    $('ls-status').textContent = 'saved ✓';
    setTimeout(() => { if ($('ls-status').textContent === 'saved ✓') $('ls-status').textContent = ''; }, 1200);
    return true;
  } catch (err) {
    $('ls-status').textContent = 'save failed';
    console.error(err);
    return false;
  }
}

$('ls-fields').addEventListener('change', (ev) => {
  const inp = ev.target.closest('input[data-lsfield]');
  const e = currentLs();
  if (!inp || !e) return;
  const k = inp.dataset.lsfield, v = inp.value.trim();
  if (v) e[k] = v; else delete e[k];
  saveLsFields({ [k]: v });
  if (k === 'title') renderLibLists();          // list rows + song filtering
  if (k === 'signature') renderLsInfo(e);       // default cpm may change
});

// ---- chords-per-measure ----------------------------------------------------
function tokensOf(line, cpm) {
  const t = String(line || '').trim().split(/\s+/).filter(Boolean);
  while (t.length < cpm) t.push('%');
  return t.slice(0, cpm);
}
$('ls-cpm').addEventListener('change', (ev) => {
  const e = currentLs();
  if (!e) return;
  const nv = parseInt(ev.target.value, 10);
  const old = lsCpm(e);
  if (!(nv > 0)) { ev.target.value = old; return; }
  if (nv === old) { e.chords_per_measure = nv; saveLsFields({ chords_per_measure: nv }); return; }
  if (nv < old && !confirm(
    `Reduce chords per measure to ${nv}?\nThe last ${old - nv} chord slot(s) of every line will be cut off.`)) {
    ev.target.value = old;
    return;
  }
  const adjust = (lines) => lines.map((l) => {
    const t = tokensOf(l, old);
    return (nv < old ? t.slice(0, nv) : t.concat(Array(nv - old).fill('%'))).join(' ');
  });
  e.chords_per_measure = nv;
  e.chord_changes = adjust(e.chord_changes || []);
  const fields = { chords_per_measure: nv, chord_changes: e.chord_changes };
  if (Array.isArray(e.coda)) { e.coda = adjust(e.coda); fields.coda = e.coda; }
  saveLsFields(fields);
  renderLsInfo(e);
});

// ---- chord grid editor (spreadsheet-style) ---------------------------------
function renderChordGrid(container, lines, cpm, which) {
  container.innerHTML = lines.map((line, r) => {
    const toks = tokensOf(line, cpm);
    return `<div class="cg-row">` +
      `<span class="cg-num">${r + 1}</span>` +
      toks.map((t, c) =>
        `<input class="cg-cell" data-which="${which}" data-row="${r}" data-col="${c}" ` +
        `value="${escapeHtml(t)}" autocomplete="off" spellcheck="false" />`).join('') +
      `<button class="cg-del" tabindex="-1" data-which="${which}" data-row="${r}" title="Delete measure">×</button>` +
      `</div>`;
  }).join('') || '<div class="muted">no measures — press Add coda / edit to create</div>';
}
function linesFor(which) {
  const e = currentLs();
  if (!e) return null;
  return which === 'coda' ? e.coda : e.chord_changes;
}
// Commit a cell's value into the entry (empty -> '%'); returns the lines array.
function commitCell(inp) {
  const e = currentLs();
  const lines = linesFor(inp.dataset.which);
  if (!e || !lines) return null;
  const r = +inp.dataset.row, c = +inp.dataset.col;
  const toks = tokensOf(lines[r], lsCpm(e));
  let v = inp.value.trim().replace(/\s+/g, '');
  if (!v) v = '%';
  inp.value = v;
  if (toks[c] === v) return null; // unchanged
  toks[c] = v;
  lines[r] = toks.join(' ');
  return lines;
}
function focusCell(container, row, col) {
  const cell = container.querySelector(`.cg-cell[data-row="${row}"][data-col="${col}"]`);
  if (cell) { cell.focus(); cell.select(); }
}
for (const gridId of ['ls-grid', 'ls-coda-grid']) {
  const grid = $(gridId);
  grid.addEventListener('focusin', (ev) => {
    if (ev.target.classList.contains('cg-cell')) setTimeout(() => ev.target.select(), 0);
  });
  grid.addEventListener('change', (ev) => {
    if (!ev.target.classList.contains('cg-cell')) return;
    const lines = commitCell(ev.target);
    if (lines) saveLsFields({ [ev.target.dataset.which]: lines }); // real-time save
  });
  grid.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (!t.classList.contains('cg-cell') || ev.key !== 'Enter') return;
    ev.preventDefault();
    const which = t.dataset.which;
    const e = currentLs();
    const lines = linesFor(which);
    if (!e || !lines) return;
    const changed = commitCell(t);
    const r = +t.dataset.row;
    if (r + 1 >= lines.length) {
      lines.push(Array(lsCpm(e)).fill('%').join(' '));   // grow: new empty measure
      saveLsFields({ [which]: lines });
      renderChordGrid(grid, lines, lsCpm(e), which);
      renderLibLists(); // bar count in the list
    } else if (changed) {
      saveLsFields({ [which]: lines });
    }
    focusCell(grid, r + 1, 0);
  });
  grid.addEventListener('click', (ev) => {
    const del = ev.target.closest('.cg-del');
    if (!del) return;
    const which = del.dataset.which;
    const e = currentLs();
    const lines = linesFor(which);
    if (!e || !lines) return;
    lines.splice(+del.dataset.row, 1);
    saveLsFields({ [which]: lines });
    renderChordGrid(grid, lines, lsCpm(e), which);
    renderLibLists();
  });
}

// ---- coda ------------------------------------------------------------------
$('ls-add-coda').addEventListener('click', () => {
  const e = currentLs();
  if (!e || Array.isArray(e.coda)) return;
  e.coda = [Array(lsCpm(e)).fill('%').join(' ')];
  saveLsFields({ coda: e.coda });
  renderLsInfo(e);
  renderLibLists();
});
$('ls-del-coda').addEventListener('click', () => {
  const e = currentLs();
  if (!e || !Array.isArray(e.coda)) return;
  if (!confirm('Remove the coda progression from this lead sheet?')) return;
  delete e.coda;
  saveLsFields({ coda: null });
  renderLsInfo(e);
  renderLibLists();
});

// ---- lead sheet add / delete ----------------------------------------------
$('lib-add-ls').addEventListener('click', async () => {
  const title = prompt('Title of the new standard:');
  if (!title || !title.trim()) return;
  try {
    const r = await fetch('/api/leadsheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim() }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    await loadLeadsheets();
    lib.selectedLs = d.index;
    lib.selectedSong = null;
    renderLibrary();
    syncEditLeadsheet();
  } catch (err) { alert('Could not create lead sheet: ' + err.message); }
});
$('ls-delete').addEventListener('click', async () => {
  const e = currentLs();
  if (!e) return;
  if (!confirm(`Delete lead sheet "${e.title}"?\nSongs of this standard are NOT affected.`)) return;
  try {
    const r = await fetch(`/api/leadsheets/${e.index}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    lib.selectedLs = null;
    await loadLeadsheets();
    renderLibrary();
    syncEditLeadsheet();
  } catch (err) { alert('Delete failed: ' + err.message); }
});

// ---- song add / delete -----------------------------------------------------
$('lib-add-song').addEventListener('click', async () => {
  const yt = prompt('YouTube ID for the new song (becomes its file name):');
  if (!yt || !yt.trim()) return;
  const selLs = currentLs();
  const std = prompt('Standard (title):', selLs ? selLs.title : '') || '';
  try {
    const r = await fetch('/api/songs/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yt_id: yt.trim(), standard: std.trim() }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    await loadSongs();
    lib.selectedSong = d.stem;
    renderLibrary();
  } catch (err) { alert('Could not add song: ' + err.message); }
});
$('lib-song-delete').addEventListener('click', async () => {
  const s = currentLibSong();
  if (!s) return;
  if (!confirm(`Delete song "${s.standard || s.stem}" from the library?\n` +
    'Only the metadata entry is removed — its files stay on disk.')) return;
  try {
    const r = await fetch(`/api/song/${s.stem}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    lib.selectedSong = null;
    await loadSongs();
    renderLibrary();
  } catch (err) { alert('Delete failed: ' + err.message); }
});

// ---- library song inspector ------------------------------------------------
function renderLibSongInfo(s) {
  $('lib-song-info').classList.remove('hidden');
  $('lib-key-select').innerHTML = keyOptionsHtml(s.key || '');
  $('lib-song-fields').innerHTML = songFieldsHtml(s, 'data-libfield');
  updateLibSongLinks(s);
  updateCompleteButton($('lib-btn-complete'), s);
  $('lib-btn-refresh').disabled = lib.refreshBusy;
}
function updateLibSongLinks(s) {
  const links = [];
  if (s.yt_id) {
    links.push(`<a href="https://www.youtube.com/watch?v=${encodeURIComponent(s.yt_id)}" target="_blank" rel="noopener">▶ Open on YouTube</a>`);
  }
  if (s.musicbrainz_id) {
    links.push(`<a href="https://musicbrainz.org/recording/${encodeURIComponent(s.musicbrainz_id)}" target="_blank" rel="noopener">♪ Open in MusicBrainz</a>`);
  }
  $('lib-song-links').innerHTML = links.join('');
}
$('lib-song-fields').addEventListener('change', (ev) => {
  const inp = ev.target.closest('input[data-libfield]');
  const s = currentLibSong();
  if (!inp || !s) return;
  const field = inp.dataset.libfield, value = inp.value.trim();
  s[field] = value;
  if (state.current && state.current.stem === s.stem && state.current !== s) state.current[field] = value;
  postMetaFields(s.stem, { [field]: value }, $('lib-song-status'));
  if (field === 'standard') { renderLibLists(); syncEditLeadsheet(); }
  if (field === 'yt_id' || field === 'musicbrainz_id') updateLibSongLinks(s);
});
$('lib-key-select').addEventListener('change', (ev) => {
  const s = currentLibSong();
  if (!s) return;
  s.key = ev.target.value;
  if (state.current && state.current.stem === s.stem && state.current !== s) state.current.key = s.key;
  fetch(`/api/key/${s.stem}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: s.key }),
  }).catch(console.error);
  ev.target.blur();
});
$('lib-btn-complete').addEventListener('click', () => toggleCompleted(currentLibSong()));

// ---- library refresh audio -------------------------------------------------
$('lib-btn-refresh').addEventListener('click', async () => {
  const s = currentLibSong();
  if (!s || lib.refreshBusy) return;
  const ytId = (s.yt_id || '').trim();
  if (!ytId) { $('lib-refresh-status').textContent = 'Set a YouTube ID first.'; return; }
  if (!confirm(`Re-crawl audio from YouTube ID "${ytId}"?\n\n` +
    'This REPLACES the audio and beat tracking and REMOVES all chord, section ' +
    'and structure labels for this song.')) return;
  lib.refreshBusy = true;
  $('lib-btn-refresh').disabled = true;
  $('lib-refresh-status').textContent = 'Starting…';
  try {
    const r = await fetch(`/api/refresh/${s.stem}`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    pollLibRefresh(s.stem);
  } catch (err) {
    $('lib-refresh-status').textContent = 'Error: ' + err.message;
    lib.refreshBusy = false;
    $('lib-btn-refresh').disabled = false;
  }
});
function pollLibRefresh(stem) {
  fetch(`/api/refresh/${stem}/status`).then((r) => r.json()).then(async (job) => {
    if (job.state === 'running') {
      $('lib-refresh-status').textContent = job.message || 'Working…';
      setTimeout(() => pollLibRefresh(stem), 1000);
    } else if (job.state === 'done') {
      $('lib-refresh-status').textContent = 'Refreshed ✓';
      lib.refreshBusy = false;
      const newStem = job.new_stem || stem;
      await loadSongs();
      if (lib.selectedSong === stem) lib.selectedSong = newStem;
      renderLibrary();
    } else {
      $('lib-refresh-status').textContent = 'Error: ' + (job.message || 'failed');
      lib.refreshBusy = false;
      $('lib-btn-refresh').disabled = false;
    }
  }).catch((err) => {
    $('lib-refresh-status').textContent = 'Error: ' + err.message;
    lib.refreshBusy = false;
    $('lib-btn-refresh').disabled = false;
  });
}

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
populateKeySelect();
setTab('library');
(async () => {
  await Promise.all([loadSongs(), loadLeadsheets()]);
  renderLibrary();
})();
