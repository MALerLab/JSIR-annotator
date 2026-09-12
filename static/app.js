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

// ----------------------------------------------------------------------------
// Harte chord notation ({root}:{shorthand}({extensions})/{bass}) -- mirrors
// jsd/chords.py. Used to transpose lead-sheet progressions into the recording's
// key when inserting chords; only the root moves, since the shorthand, the
// extensions and the bass are all written relative to it.
// ----------------------------------------------------------------------------
const NOTE_LETTERS = 'CDEFGAB';
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];      // pitch class of each natural letter
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// Position of each major tonic on the circle of fifths (sharp keys are > 0).
const FIFTHS = {
  Cb: -7, Gb: -6, Db: -5, Ab: -4, Eb: -3, Bb: -2, F: -1, C: 0,
  G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, 'G#': 8, 'D#': 9, 'A#': 10,
};

// Leading note name of `s` -> {letter: 0-6, acc: accidentals, len: chars}.
function parseNote(s) {
  const m = /^([A-G])([#b]*)/.exec(s || '');
  if (!m) return null;
  const acc = (m[2].match(/#/g) || []).length - (m[2].match(/b/g) || []).length;
  return { letter: NOTE_LETTERS.indexOf(m[1]), acc, len: m[0].length };
}

// Pitch class of a complete note name ('Bb' -> 10), or null.
function notePc(name) {
  const n = parseNote(name);
  if (!n || n.len !== String(name).length) return null;
  return (((LETTER_PC[n.letter] + n.acc) % 12) + 12) % 12;
}

// Spell pitch class `pc` on note letter `letter`. Distant key pairs can push a
// letter more than one accidental from its pitch (Ab's B:maj7 is G##:maj7 in
// F#); those fall back to a plain sharp/flat spelling of the same pitch.
function spellNote(letter, pc, preferSharps) {
  const li = ((letter % 7) + 7) % 7;
  const acc = ((((pc - LETTER_PC[li]) % 12) + 12 + 6) % 12) - 6;
  if (Math.abs(acc) > 1) return (preferSharps ? SHARP_NAMES : FLAT_NAMES)[((pc % 12) + 12) % 12];
  return NOTE_LETTERS[li] + (acc > 0 ? '#'.repeat(acc) : 'b'.repeat(-acc));
}

// Key label -> [root note name, mode]. Accepts the lead-sheet form ('Ab-maj')
// and the song form ('D maj', 'F minor').
function parseKey(k) {
  if (!k) return [null, null];
  const s = String(k).trim();
  const cut = s.includes('-') ? s.indexOf('-') : s.indexOf(' ');
  const root = (cut < 0 ? s : s.slice(0, cut)).trim();
  if (notePc(root) === null) return [null, null];
  const mode = (cut < 0 ? '' : s.slice(cut + 1)).trim().toLowerCase();
  return [root, mode.startsWith('min') ? 'min' : 'maj'];
}

function keyPrefersSharps(k) {
  const [root, mode] = parseKey(k);
  if (root === null) return false;
  return (FIFTHS[root] || 0) - (mode === 'min' ? 3 : 0) > 0;
}

// How to move chords written in `fromKey` so they sound in `toKey`. Shifting
// the note letter as well as the pitch keeps the spelling musical: Ab -> Db
// takes F:min7 to Bb:min7, not to the enharmonic A#:min7. null if either key
// is unknown; `letters` alone (semitones 0) just respells.
function transposeShift(fromKey, toKey) {
  const [a] = parseKey(fromKey);
  const [b] = parseKey(toKey);
  if (a === null || b === null) return null;
  return {
    letters: ((parseNote(b).letter - parseNote(a).letter) % 7 + 7) % 7,
    semitones: ((notePc(b) - notePc(a)) % 12 + 12) % 12,
    sharps: keyPrefersSharps(toKey),
  };
}
const shiftIsNoop = (sh) => !sh || (!sh.letters && !sh.semitones);

// Transpose one Harte chord token. 'N' (no chord), '%' (hold) and anything
// unparseable pass through untouched.
function transposeChordToken(tok, shift) {
  const t = String(tok || '').trim();
  if (!t || t === '%' || t === 'N') return tok;
  const main = t.split('/')[0];
  const n = parseNote(main);
  if (!n) return tok;
  const rest = main.slice(n.len);
  if (rest && !rest.startsWith(':')) return tok;   // not Harte -> leave alone
  return spellNote(n.letter + shift.letters,
    (((LETTER_PC[n.letter] + n.acc + shift.semitones) % 12) + 12) % 12,
    shift.sharps) + t.slice(n.len);
}

const SCHED_MS = 25;          // metronome scheduler tick (ms)

const state = {
  songs: [],
  songSort: { key: 'name', dir: 'asc' },   // sidebar list order
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
  // position in metadata.json == the order entries were added; kept for sorting
  state.songs.forEach((s, i) => { s._ord = i; });
  renderSongList();
}

// ---- list sorting (sidebar song list + both library lists) -----------------
// Keys: 'name', 'artist' (songs only), 'added' (the order in the JSON file).
function cmpText(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined,
    { sensitivity: 'base', numeric: true });
}

// Sorts `rows` in place (callers pass a filtered copy) and returns it.
function sortSongs(rows, sort) {
  const dir = sort.dir === 'desc' ? -1 : 1;
  return rows.sort((a, b) => {
    let c = 0;
    if (sort.key === 'name') c = cmpText(a.standard, b.standard) || cmpText(a.artist, b.artist);
    else if (sort.key === 'artist') c = cmpText(a.artist, b.artist) || cmpText(a.standard, b.standard);
    if (!c) c = (a._ord || 0) - (b._ord || 0);   // 'added', and the tie-break for the rest
    return c * dir;
  });
}

function sortLeadsheets(rows, sort) {
  const dir = sort.dir === 'desc' ? -1 : 1;
  return rows.sort((a, b) => {
    let c = sort.key === 'name' ? cmpText(a.title, b.title) : 0;
    if (!c) c = a.index - b.index;              // 'added' = order in lead_sheets.json
    return c * dir;
  });
}

// Binds a <select> + direction button pair to a {key, dir} state object.
function wireSort(prefix, sort, rerender) {
  const sel = $(`${prefix}-sort`), btn = $(`${prefix}-sort-dir`);
  const paint = () => {
    sel.value = sort.key;
    btn.textContent = sort.dir === 'desc' ? '\u2193' : '\u2191';
    btn.title = sort.dir === 'desc'
      ? 'Descending \u2014 click for ascending' : 'Ascending \u2014 click for descending';
  };
  sel.addEventListener('change', () => { sort.key = sel.value; rerender(); });
  btn.addEventListener('click', () => {
    sort.dir = sort.dir === 'desc' ? 'asc' : 'desc';
    paint();
    rerender();
  });
  paint();
}

function renderSongList() {
  const ul = $('song-list');
  const filter = $('song-filter').value.toLowerCase();
  ul.innerHTML = '';
  const rows = state.songs.filter((s) =>
    [s.standard, s.artist, s.album, s.instrumentation]
      .filter(Boolean).join(' ').toLowerCase().includes(filter)
  );
  sortSongs(rows, state.songSort)
    .forEach((s) => {
      const li = document.createElement('li');
      if (state.current && state.current.id === s.id) li.classList.add('active');
      const sub = [s.artist, s.instrumentation].filter(Boolean).join(' · ');
      li.innerHTML =
        `<div class="t">${escapeHtml(s.standard || '(untitled)')}` +
        (s.completed ? '<span class="dot" title="completed">●</span>' : '') +
        (s.has_audio ? '' : '<span class="tag">no audio</span>') +
        `</div><div class="a">${escapeHtml(sub)}</div>`;
      if (!s.has_audio) {
        // added by curation but not crawled yet -> nothing to edit
        li.classList.add('noaudio');
        li.title = 'No audio yet — crawl this song in the Library tab';
        li.onclick = () => { setStatus('no audio yet — crawl this song in the Library tab'); setTimeout(() => setStatus(''), 2500); };
      } else {
        li.onclick = () => selectSong(s);
      }
      ul.appendChild(li);
    });
}

$('song-filter').addEventListener('input', renderSongList);
wireSort('song', state.songSort, renderSongList);

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
  const listed = state.songs.find((x) => x.id === song.id);
  if (listed) listed.completed = nv;
  if (state.current && state.current.id === song.id) {
    state.current.completed = nv;
    updateCompleteButton($('btn-complete'), state.current);
  }
  renderSongList();
  if (lib.tab === 'library') renderLibrary();
  const ok = await postMetaFields(song.id, { completed: nv }, null);
  if (!ok) { // revert on failure
    song.completed = !nv;
    if (listed) listed.completed = !nv;
    if (state.current && state.current.id === song.id) {
      state.current.completed = !nv;
      updateCompleteButton($('btn-complete'), state.current);
    }
    renderSongList();
    if (lib.tab === 'library') renderLibrary();
  }
}
async function postMetaFields(songId, fields, statusEl) {
  if (statusEl) statusEl.textContent = 'saving…';
  try {
    const r = await fetch(`/api/meta/${songId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    if (statusEl) {
      statusEl.textContent = 'saved ✓';
      setTimeout(() => { if (statusEl.textContent === 'saved ✓') statusEl.textContent = ''; }, 1200);
    }
    return true;
  } catch (err) {
    if (statusEl) statusEl.textContent = 'save failed: ' + err.message;
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
  const listed = state.songs.find((s) => s.id === song.id);
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
    const res = await fetch(`/api/meta/${song.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { [field]: value } }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
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
    const res = await fetch(`/api/key/${song.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    song.key = key;                       // keep in-memory list in sync
    const listed = state.songs.find((s) => s.id === song.id);
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

  const id = song.id;
  refreshBusy = true;
  $('btn-refresh').disabled = true;
  setRefreshStatus('Starting…', 'busy');
  try {
    const res = await fetch(`/api/refresh/${id}`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    pollRefresh(id);
  } catch (err) {
    setRefreshStatus('Error: ' + err.message, 'err');
    refreshBusy = false;
    $('btn-refresh').disabled = false;
  }
}

function pollRefresh(id) {
  fetch(`/api/refresh/${id}/status`)
    .then((r) => r.json())
    .then(async (job) => {
      if (job.state === 'running') {
        setRefreshStatus(job.message || 'Working…', 'busy');
        setTimeout(() => pollRefresh(id), 1000);
      } else if (job.state === 'done') {
        setRefreshStatus('Done — reloading…', 'ok');
        await reloadAfterRefresh(id);
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

async function reloadAfterRefresh(id) {
  // metadata changed (files re-keyed, labels dropped) -> refresh the list…
  await loadSongs();
  // …then, only if the user is still on this song, reload it with fresh audio.
  if (!state.current || state.current.id !== id) return;
  const song = state.songs.find((s) => s.id === id);
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
// Flatten bar strings ("F:min7 % % %") into a per-beat token list.
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
// Distinct consecutive (non-%) chords in a bar: "G:min7 % C:7 %" -> ["G:min7","C:7"].
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
// How to transpose lead-sheet chords into the recording's key, or null for
// "leave them as written" (toggle off, or either key missing/unreadable).
function insertShift() {
  if (!$('ins-transpose').checked) return null;
  const sh = transposeShift(state.leadsheet && state.leadsheet.key,
                            state.current && state.current.key);
  return shiftIsNoop(sh) ? null : sh;
}
// " (transposed +5)" / " (respelled)" for the insertion status line.
function shiftLabel(sh) {
  if (!sh) return '';
  return sh.semitones ? ` (transposed +${sh.semitones})` : ' (respelled)';
}
// Map progression beats onto the section's beats (looping), starting at
// progression index `startOffset`, overwriting existing chords in the region.
function insertProgression(sec, prog, startOffset) {
  if (!prog.length) return;
  const secBeats = sectionBeatsIn(sec);
  if (!secBeats.length) { flashStatus('no beats in this section'); return; }
  const shift = insertShift();
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
    const name = shift ? transposeChordToken(tok, shift) : tok;
    state.chords.push({ time: secBeats[i].t, chord: name });
    count++;
  }
  state.chords.sort((a, b) => a.time - b.time);
  markDirty();
  scheduleRender();
  updateInspector();
  flashStatus(`inserted ${count} chords${shiftLabel(shift)}`);
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
  const shift = insertShift();
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
      const name = shift ? transposeChordToken(tok, shift) : tok;
      state.chords.push({ time: mBeats[pos].t, chord: name });
      count++;
    }
  }
  state.chords.sort((a, b) => a.time - b.time);
  markDirty();
  scheduleRender();
  updateInspector();
  flashStatus(`inserted ${count} chords${shiftLabel(shift)}`);
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
  chordAnchor = null;
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
    const ch = { time: t, chord: 'N' };
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

// ---- chord multi-select / clipboard ----------------------------------------
let chordAnchor = null;     // fixed anchor for shift-click range selection
let chordClipboard = null;  // [{off, chord}] — off = beat distance from the first

// Shift-click on a chord: select every chord between the anchor and the click.
function selectChordRange(to) {
  const anchor =
    (chordAnchor && state.chords.includes(chordAnchor)) ? chordAnchor
    : (state.selected && state.selected.kind === 'chord') ? state.selected.obj : null;
  if (!anchor) { chordAnchor = to; selectChordObj(to); return; }
  chordAnchor = anchor;
  const lo = Math.min(anchor.time, to.time), hi = Math.max(anchor.time, to.time);
  const arr = state.chords
    .filter((c) => c.time >= lo - 1e-9 && c.time <= hi + 1e-9)
    .sort((a, b) => a.time - b.time);
  state.selBeats = new Set();
  state.selEvents = new Set(arr);
  state.selected = { kind: 'chord', obj: to };   // inspector follows the click
}

// Ctrl+C: remember the selected chords as BEAT offsets from the first one, so a
// paste can re-align them onto whatever beats follow the target.
function copyChords() {
  if (!state.selected || state.selected.kind !== 'chord' || !state.selEvents.size) return false;
  if (!state.beats.length) return false;
  const arr = [...state.selEvents].sort((a, b) => a.time - b.time);
  const i0 = nearestBeatIndex(arr[0].time);
  chordClipboard = arr.map((c) => ({ off: nearestBeatIndex(c.time) - i0, chord: c.chord }));
  setStatus(`copied ${arr.length} chord${arr.length === 1 ? '' : 's'}`);
  setTimeout(() => setStatus(''), 1200);
  return true;
}

// Ctrl+V: write the clipboard starting at the beat nearest the playhead, keeping
// the original beat spacing and overwriting any chords already in that span.
function pasteChords() {
  if (!chordClipboard || !chordClipboard.length || !state.beats.length) return false;
  const start = nearestBeatIndex(curPos());
  if (start < 0) return false;
  const byIdx = new Map();                        // collisions: last one wins
  for (const item of chordClipboard) {
    const idx = start + item.off;
    if (idx < 0 || idx >= state.beats.length) continue;   // ran past the track
    byIdx.set(idx, item.chord);
  }
  const placed = [...byIdx.keys()].sort((a, b) => a - b)
    .map((idx) => ({ time: state.beats[idx].t, chord: byIdx.get(idx) }));
  if (!placed.length) {
    setStatus('nothing to paste (past the last beat)');
    setTimeout(() => setStatus(''), 1500);
    return false;
  }
  pushUndo();
  const t0 = placed[0].time, t1 = placed[placed.length - 1].time;
  state.chords = state.chords.filter((c) => c.time < t0 - 1e-9 || c.time > t1 + 1e-9);
  state.chords.push(...placed);
  state.chords.sort((a, b) => a.time - b.time);
  setEventSelection('chord', placed);
  chordAnchor = placed[0];
  markDirty();
  scheduleRender();
  updateInspector();
  setStatus(`pasted ${placed.length} chord${placed.length === 1 ? '' : 's'}`);
  setTimeout(() => setStatus(''), 1200);
  return true;
}

// Tab / Shift+Tab in the chord-name box: step to the next / previous chord in
// time and select its name so it can be retyped straight away.
function stepChordSelection(dir) {
  if (!state.selected || state.selected.kind !== 'chord') return false;
  const sorted = [...state.chords].sort((a, b) => a.time - b.time);
  const next = sorted[sorted.indexOf(state.selected.obj) + dir];
  if (!next) return false;
  chordAnchor = next;
  selectChordObj(next);
  scheduleRender();
  updateInspector();
  const inp = $('chord-name');
  inp.focus();
  inp.select();
  return true;
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
// Tab walks the chord lane: next chord in time (Shift+Tab = previous), with its
// name pre-selected so a whole progression can be typed without the mouse.
$('chord-name').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (stepChordSelection(e.shiftKey ? -1 : 1)) e.preventDefault();
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
      if (e.shiftKey) {
        selectChordRange(ch);          // range-select, no drag
      } else {
        chordAnchor = ch;
        selectChordObj(ch);
        drag = { kind: 'chord', obj: ch };
        waveCanvas.setPointerCapture(e.pointerId);
      }
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
    const song = state.songs.find((s) => s.id === state.current.id);
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
    // copy / paste chord events (falls through to the browser when unused)
    else if (e.key === 'c' || e.key === 'C') { if (copyChords()) e.preventDefault(); }
    else if (e.key === 'v' || e.key === 'V') { if (pasteChords()) e.preventDefault(); }
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
  selectedSong: null,   // song id, or null
  lsSort: { key: 'name', dir: 'asc' },
  songSort: { key: 'name', dir: 'asc' },
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
  return state.songs.find((s) => s.id === lib.selectedSong) || null;
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
  for (const [mode, label] of [['maj', 'Major'], ['min', 'Minor']]) {
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
  const lsRows = lib.leadsheets.filter((e) => (e.title || '').toLowerCase().includes(lsq));
  sortLeadsheets(lsRows, lib.lsSort)
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
  const songRows = state.songs
    .filter((s) => selTitle == null || (s.standard || '').trim().toLowerCase() === selTitle)
    .filter((s) =>
      [s.standard, s.artist, s.album].filter(Boolean).join(' ').toLowerCase().includes(sq));
  sortSongs(songRows, lib.songSort)
    .forEach((s) => {
      const li = document.createElement('li');
      if (lib.selectedSong === s.id) li.classList.add('active');
      li.innerHTML =
        `<div class="t">${escapeHtml(s.standard || '(untitled)')}` +
        (s.completed ? '<span class="dot" title="completed">●</span>' : '') +
        (s.has_audio ? '' : '<span class="tag">no audio</span>') +
        `</div><div class="a">${escapeHtml(s.artist || '')}</div>`;
      li.onclick = () => {
        lib.selectedSong = (lib.selectedSong === s.id) ? null : s.id;
        renderLibrary();
      };
      su.appendChild(li);
    });
}
$('lib-ls-filter').addEventListener('input', renderLibLists);
$('lib-song-filter').addEventListener('input', renderLibLists);
wireSort('lib-ls', lib.lsSort, renderLibLists);
wireSort('lib-song', lib.songSort, renderLibLists);

function renderLibInspector() {
  $('lib-stats').classList.add('hidden');
  $('lib-ls-info').classList.add('hidden');
  $('lib-song-info').classList.add('hidden');
  const song = currentLibSong();
  const ls = currentLs();
  if (song) renderLibSongInfo(song);
  else if (ls) renderLsInfo(ls);
  else renderLibStats();
  renderCollection();   // the right-hand collection pane follows the selection
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
  ['composer', 'Composer'],
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
  renderLsMbLink(e);
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
    lib.selectedSong = d.id;
    renderLibrary();
  } catch (err) { alert('Could not add song: ' + err.message); }
});
$('lib-song-delete').addEventListener('click', async () => {
  const s = currentLibSong();
  if (!s) return;
  if (!confirm(`Delete song "${s.standard || s.stem || s.id}" from the library?\n` +
    'Only the metadata entry is removed — its files stay on disk.')) return;
  try {
    const r = await fetch(`/api/song/${s.id}`, { method: 'DELETE' });
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
  setCrawlButtons();
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
  if (state.current && state.current.id === s.id && state.current !== s) state.current[field] = value;
  postMetaFields(s.id, { [field]: value }, $('lib-song-status')).then((ok) => {
    // rejected (e.g. duplicate YouTube ID) -> resync from the server
    if (!ok) loadSongs().then(renderLibrary);
  });
  if (field === 'standard') { renderLibLists(); syncEditLeadsheet(); }
  if (field === 'yt_id' || field === 'musicbrainz_id') updateLibSongLinks(s);
  if (field === 'yt_id') renderCollection();
});
$('lib-key-select').addEventListener('change', (ev) => {
  const s = currentLibSong();
  if (!s) return;
  s.key = ev.target.value;
  if (state.current && state.current.id === s.id && state.current !== s) state.current.key = s.key;
  fetch(`/api/key/${s.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: s.key }),
  }).catch(console.error);
  ev.target.blur();
});
$('lib-btn-complete').addEventListener('click', () => toggleCompleted(currentLibSong()));

// ---- library refresh audio -------------------------------------------------
// Crawl / re-crawl a song's audio from the Library (Song Info "Refresh audio"
// and step ③ "Crawl audio" share this). Status is mirrored to both places.
function setCrawlStatus(text) {
  $('lib-refresh-status').textContent = text;
  $('yt-crawl-status').textContent = text;
}
function setCrawlButtons() {
  const s = currentLibSong();
  $('lib-btn-refresh').disabled = lib.refreshBusy || !s;
  $('yt-crawl').disabled = lib.refreshBusy || !s || !(s.yt_id || '').trim();
}
async function startLibCrawl(s) {
  if (!s || lib.refreshBusy) return;
  const ytId = (s.yt_id || '').trim();
  if (!ytId) { setCrawlStatus('Set a YouTube ID first.'); return; }
  if (s.has_audio && !confirm(`Re-crawl audio from YouTube ID "${ytId}"?\n\n` +
    'This REPLACES the audio and beat tracking and REMOVES all chord, section ' +
    'and structure labels for this song.')) return;
  lib.refreshBusy = true;
  setCrawlButtons();
  setCrawlStatus('Starting…');
  try {
    const r = await fetch(`/api/refresh/${s.id}`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    pollLibRefresh(s.id);
  } catch (err) {
    setCrawlStatus('Error: ' + err.message);
    lib.refreshBusy = false;
    setCrawlButtons();
  }
}
$('lib-btn-refresh').addEventListener('click', () => startLibCrawl(currentLibSong()));
function pollLibRefresh(id) {
  fetch(`/api/refresh/${id}/status`).then((r) => r.json()).then(async (job) => {
    if (job.state === 'running') {
      setCrawlStatus(job.message || 'Working…');
      setTimeout(() => pollLibRefresh(id), 1000);
    } else if (job.state === 'done') {
      lib.refreshBusy = false;
      await loadSongs();
      renderLibrary();
      setCrawlStatus('Crawled ✓');
      setCrawlButtons();
    } else {
      setCrawlStatus('Error: ' + (job.message || 'failed'));
      lib.refreshBusy = false;
      setCrawlButtons();
    }
  }).catch((err) => {
    setCrawlStatus('Error: ' + err.message);
    lib.refreshBusy = false;
    setCrawlButtons();
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

// ============================================================================
// COLLECTION PANE — ① MusicBrainz work · ② curate recordings · ③ crawl audio
// ============================================================================
const col = {
  step: 'work',           // 'work' | 'curate' (lead-sheet steps)
  lsIndex: null,          // lead sheet the work/curation state belongs to
  works: [], worksCount: 0, worksBusy: false,
  openWork: null,         // work expanded in step ①
  recs: {},               // work id -> {state, message, error, work, recordings, fetched_at, shown}
  curSel: new Set(),      // recording ids ticked in step ②
  songId: null,           // song the YouTube state belongs to
  yt: { results: [], preview: null, busy: false },
};
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function setColStatus(id, text, isErr) {
  const el = $(id);
  el.textContent = text || '';
  el.classList.toggle('err', !!isErr);
}
function fmtLen(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtFetched(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
// recording mbid -> song already in the dataset
function datasetByMbid() {
  const m = new Map();
  for (const s of state.songs) if (s.musicbrainz_id) m.set(s.musicbrainz_id, s);
  return m;
}
// Lead-sheet key ("Ab-maj") -> song key vocabulary ("Ab maj"), enharmonics folded.
const ENHARMONIC = { 'C#': 'Db', 'D#': 'Eb', Gb: 'F#', 'G#': 'Ab', 'A#': 'Bb' };
function lsKeyToSongKey(k) {
  const m = /^([A-G][b#]?)[\s-]*(maj|min)/i.exec((k || '').trim());
  if (!m) return '';
  const root = ENHARMONIC[m[1]] || m[1];
  return KEY_ROOTS.includes(root) ? `${root} ${m[2].toLowerCase()}` : '';
}
function inheritedFromLs(ls) {
  const out = {};
  const key = lsKeyToSongKey(ls.key);
  if (key) out.key = key;
  if (Array.isArray(ls.chord_changes) && ls.chord_changes.length) out.num_bars = ls.chord_changes.length;
  if (ls.tempoclass) out.tempo_class = ls.tempoclass;
  if (ls.rhythmfeel) out.rhythm_feel = ls.rhythmfeel;
  if (ls.signature) out.time_signature = ls.signature;
  return out;
}

// ---- pane switching ----------------------------------------------------------
function renderCollection() {
  const song = currentLibSong(), ls = currentLs();
  $('col-empty').classList.toggle('hidden', !!(song || ls));
  $('col-ls').classList.toggle('hidden', !(ls && !song));
  $('col-song').classList.toggle('hidden', !song);
  if (song) {
    if (col.songId !== song.id) resetYt(song);
    renderYt(song);
  } else if (ls) {
    if (col.lsIndex !== ls.index) resetWorkState(ls);
    renderLsSteps(ls);
  }
}
function resetWorkState(ls) {
  col.lsIndex = ls.index;
  col.works = []; col.worksCount = 0; col.openWork = null;
  col.curSel = new Set();
  col.step = ls.musicbrainz_id ? 'curate' : 'work';   // linked -> straight to curation
  $('mb-q').value = ls.title || '';
  $('mb-works').innerHTML = '';
  $('cur-filter').value = '';
  setColStatus('mb-status', '');
  setColStatus('cur-status', '');
  $('cur-add-status').textContent = '';
}
function renderLsSteps(ls) {
  const linked = !!ls.musicbrainz_id;
  document.querySelectorAll('#col-ls .col-steps .step').forEach((b) => {
    b.classList.toggle('active', b.dataset.step === col.step);
    b.classList.toggle('done', b.dataset.step === 'work' && linked);
  });
  $('col-work').classList.toggle('hidden', col.step !== 'work');
  $('col-curate').classList.toggle('hidden', col.step !== 'curate');
  if (col.step === 'work') renderWorks(ls); else renderCurate(ls);
}
document.querySelectorAll('#col-ls .col-steps .step').forEach((b) => {
  b.addEventListener('click', () => {
    col.step = b.dataset.step;
    const ls = currentLs();
    if (ls) renderLsSteps(ls);
  });
});
// re-render whichever lead-sheet step is showing (after async fetches)
function rerenderLsStep() {
  const ls = currentLs();
  if (ls && !currentLibSong() && lib.tab === 'library') renderLsSteps(ls);
}

// ---- ① work search -----------------------------------------------------------
async function searchWorks(more) {
  const ls = currentLs();
  if (!ls || col.worksBusy) return;
  const q = $('mb-q').value.trim();
  if (!q) return;
  const offset = more ? col.works.length : 0;
  if (!more) { col.works = []; col.worksCount = 0; col.openWork = null; renderWorks(ls); }
  col.worksBusy = true;
  $('mb-search').disabled = true;
  setColStatus('mb-status', 'Searching MusicBrainz…');
  try {
    const r = await fetch(`/api/mb/works?q=${encodeURIComponent(q)}&offset=${offset}&limit=25`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    if (currentLs() !== ls) return;               // user moved on
    col.works = more ? col.works.concat(d.works) : d.works;
    col.worksCount = d.count || col.works.length;
    col.works.sort((a, b) => b.recording_count - a.recording_count || (b.score || 0) - (a.score || 0));
    setColStatus('mb-status', col.works.length
      ? `${col.works.length} of ${col.worksCount} works · sorted by number of recordings`
      : 'No works found — try a shorter title or MusicBrainz query syntax.');
  } catch (err) {
    setColStatus('mb-status', 'Error: ' + err.message, true);
  } finally {
    col.worksBusy = false;
    $('mb-search').disabled = false;
    if (currentLs() === ls) renderWorks(ls);
  }
}
$('mb-search').addEventListener('click', () => searchWorks(false));
$('mb-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchWorks(false); } });
$('mb-more').addEventListener('click', () => searchWorks(true));

function workLinkLabel(w, ls) {
  return ls.musicbrainz_id === w.id ? 'Linked to this lead sheet ✓' : `Link to “${ls.title || 'this lead sheet'}”`;
}
function renderWorks(ls) {
  const linked = ls.musicbrainz_id || '';
  $('mb-linked').innerHTML = linked
    ? `Linked work: <a href="https://musicbrainz.org/work/${encodeURIComponent(linked)}" target="_blank" rel="noopener">${escapeHtml(linked)}</a>` +
      `<span class="muted"> — its recordings are listed in step ②.</span>` +
      `<button class="small" data-act="unlink">Unlink</button>`
    : '';
  $('mb-more').classList.toggle('hidden', !(col.works.length && col.works.length < col.worksCount));
  const box = $('mb-works');
  box.innerHTML = '';
  for (const w of col.works) {
    const div = document.createElement('div');
    div.className = 'work' + (w.id === col.openWork ? ' open' : '') + (w.id === linked ? ' linked' : '');
    div.dataset.wid = w.id;
    const who = [...(w.composers || []), ...(w.lyricists || []).map((l) => `${l} (lyrics)`)].join(', ') || 'composer unknown';
    const sub = [who, w.disambiguation, w.type].filter(Boolean).join(' · ');
    div.innerHTML =
      `<div class="work-head"><span class="t">${escapeHtml(w.title || '(untitled)')}</span>` +
      (w.id === linked ? '<span class="badge">linked</span>' : '') +
      `<span class="n">${w.recording_count} recording${w.recording_count === 1 ? '' : 's'}</span></div>` +
      `<div class="work-sub">${escapeHtml(sub)}</div>`;
    if (w.id === col.openWork) {
      const body = document.createElement('div');
      body.className = 'work-body';
      body.innerHTML = workBodyHtml(w, ls);
      div.appendChild(body);
    }
    box.appendChild(div);
  }
}
function workBodyHtml(w, ls) {
  const st = col.recs[w.id];
  let h = `<div class="col-actions"><button class="primary" data-act="link" ${ls.musicbrainz_id === w.id ? 'disabled' : ''}>${escapeHtml(workLinkLabel(w, ls))}</button>` +
    `<a class="muted" href="https://musicbrainz.org/work/${encodeURIComponent(w.id)}" target="_blank" rel="noopener">open on MusicBrainz ↗</a></div>`;
  if (!st || st.state === 'idle' || st.state === 'running') {
    h += `<div class="muted col-status">${escapeHtml((st && st.message) || 'Loading recordings…')}</div>`;
  } else if (st.state === 'error') {
    h += `<div class="col-status err">Error: ${escapeHtml(st.error || 'failed')}</div><button class="small" data-act="retry">Retry</button>`;
  } else {
    const rows = st.recordings.slice(0, st.shown);
    h += recHeaderHtml(false) + rows.map((r) => recRowHtml(r, { check: false, inSong: null })).join('');
    if (st.recordings.length > st.shown) {
      h += `<button class="small more" data-act="more">Show more (${st.recordings.length - st.shown} left)</button>`;
    }
  }
  return h;
}
$('mb-works').addEventListener('click', (ev) => {
  const ls = currentLs();
  if (!ls) return;
  const workEl = ev.target.closest('.work');
  if (!workEl) return;
  const w = col.works.find((x) => x.id === workEl.dataset.wid);
  if (!w) return;
  const act = ev.target.closest('[data-act]');
  if (act) {
    ev.stopPropagation();
    if (act.dataset.act === 'link') linkWork(w);
    else if (act.dataset.act === 'more') { col.recs[w.id].shown += 25; renderWorks(ls); }
    else if (act.dataset.act === 'retry') ensureRecordings(w.id, true);
    return;
  }
  if (ev.target.closest('a')) return;               // plain links
  if (ev.target.closest('.work-body')) return;       // rows inside the expansion
  col.openWork = (col.openWork === w.id) ? null : w.id;
  if (col.openWork) ensureRecordings(w.id, false);
  renderWorks(ls);
});
$('mb-linked').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-act="unlink"]')) unlinkWork();
});

// Fetch (or poll for) the recordings of a work; results live in col.recs.
async function ensureRecordings(workId, refresh) {
  const st = col.recs[workId] || (col.recs[workId] = { state: 'idle', shown: 25 });
  if (st.state === 'running') return;
  if (st.state === 'done' && !refresh) return;
  st.state = 'running'; st.message = 'Starting…'; st.error = null;
  rerenderLsStep();
  try {
    let r = await fetch(`/api/mb/work/${workId}/recordings${refresh ? '?refresh=1' : ''}`);
    let d = await r.json().catch(() => ({}));
    while (r.ok && d.ok && d.state === 'running') {
      st.message = d.message || 'Fetching…';
      rerenderLsStep();
      await sleepMs(1200);
      r = await fetch(`/api/mb/work/${workId}/recordings`);
      d = await r.json().catch(() => ({}));
    }
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    st.state = 'done';
    st.work = d.work; st.recordings = d.recordings || []; st.fetched_at = d.fetched_at;
  } catch (err) {
    st.state = 'error'; st.error = err.message;
  }
  rerenderLsStep();
}

async function linkWork(w) {
  const ls = currentLs();
  if (!ls) return;
  const fields = { musicbrainz_id: w.id };
  const composer = (w.composers || []).join(', ');
  if (composer) fields.composer = composer;      // the linked work is authoritative
  for (const [k, v] of Object.entries(fields)) { if (v) ls[k] = v; else delete ls[k]; }
  const ok = await saveLsFields(fields);
  if (!ok) return;
  col.step = 'curate';
  col.curSel = new Set();
  renderLsInfo(ls);
  renderLibLists();
  renderLsSteps(ls);
  ensureRecordings(w.id, false);
}
async function unlinkWork() {
  const ls = currentLs();
  if (!ls || !ls.musicbrainz_id) return;
  if (!confirm(`Unlink MusicBrainz work ${ls.musicbrainz_id} from “${ls.title}”?\nIts cached recording list is discarded.`)) return;
  const old = ls.musicbrainz_id;
  delete ls.musicbrainz_id;
  const ok = await saveLsFields({ musicbrainz_id: '' });
  if (!ok) { ls.musicbrainz_id = old; return; }
  delete col.recs[old];
  col.step = 'work';
  col.curSel = new Set();
  renderLsInfo(ls);
  renderLsSteps(ls);
}
function renderLsMbLink(e) {
  const el = $('ls-mb');
  if (e.musicbrainz_id) {
    el.innerHTML =
      `<a href="https://musicbrainz.org/work/${encodeURIComponent(e.musicbrainz_id)}" target="_blank" rel="noopener">${escapeHtml(e.musicbrainz_id)}</a>` +
      '<button class="small" id="ls-unlink">Unlink</button>';
  } else {
    el.innerHTML = '<span class="muted">not linked — use step ① in the Collection pane</span>';
  }
}
$('ls-mb').addEventListener('click', (ev) => { if (ev.target.closest('#ls-unlink')) unlinkWork(); });

// ---- recording rows (shared) -------------------------------------------------
function recHeaderHtml(check) {
  return `<div class="rec head${check ? '' : ' nocheck'}">${check ? '<span></span>' : ''}` +
    '<span>Artist · album</span><span>Date</span><span>Length</span><span class="r">Appear.</span></div>';
}
function recRowHtml(r, opts) {
  const inSong = opts.inSong;
  const cls = ['rec', opts.check ? '' : 'nocheck', opts.sel ? 'sel' : '', inSong ? 'in' : ''].filter(Boolean).join(' ');
  const alb = r.album || (r.title && r.title !== (opts.workTitle || '') ? r.title : '') || '';
  return `<div class="${cls}" data-rid="${escapeHtml(r.id)}" title="${escapeHtml(r.title || '')}">` +
    (opts.check ? `<input type="checkbox" ${opts.sel ? 'checked' : ''} ${inSong ? 'disabled' : ''} />` : '') +
    `<div class="who"><div class="a">${escapeHtml(r.artist || 'Unknown')}</div>` +
    `<div class="al">${escapeHtml(alb)}${inSong ? ' <span class="in-tag">✓ in dataset</span>' : ''}</div></div>` +
    `<div class="d">${escapeHtml(r.date || '—')}</div>` +
    `<div class="l">${fmtLen(r.length_ms)}</div>` +
    `<div class="r"><b>${r.releases || 0}</b></div></div>`;
}

// ---- ② curation --------------------------------------------------------------
const CUR_SORTERS = {
  releases: (a, b) => (b.releases || 0) - (a.releases || 0) || (a.date || '9999').localeCompare(b.date || '9999'),
  date: (a, b) => (a.date || '9999').localeCompare(b.date || '9999'),
  artist: (a, b) => (a.artist || '').localeCompare(b.artist || ''),
  length: (a, b) => (a.length_ms || 1e12) - (b.length_ms || 1e12),
};
function renderCurate(ls) {
  const wid = ls.musicbrainz_id;
  const head = $('cur-head'), list = $('cur-list');
  if (!wid) {
    head.innerHTML = 'No MusicBrainz work is linked to this lead sheet yet. ' +
      '<button class="small" data-act="gowork">Go to step ①</button>';
    list.innerHTML = '';
    setColStatus('cur-status', '');
    updateCurAdd(ls);
    return;
  }
  const st = col.recs[wid];
  if (!st || st.state === 'idle') { ensureRecordings(wid, false); return; }   // re-renders when done
  const w = st.work || {};
  head.innerHTML =
    `<b>${escapeHtml(w.title || 'work')}</b>` +
    (w.composers && w.composers.length ? ` <span class="muted">· ${escapeHtml(w.composers.join(', '))}</span>` : '') +
    (st.recordings ? ` <span class="muted">· ${st.recordings.length} recordings</span>` : '') +
    (st.fetched_at ? ` <span class="muted">· fetched ${escapeHtml(fmtFetched(st.fetched_at))}</span>` : '') +
    ` <a href="https://musicbrainz.org/work/${encodeURIComponent(wid)}" target="_blank" rel="noopener">↗</a>` +
    `<button class="small" data-act="refetch" ${st.state === 'running' ? 'disabled' : ''}>↻ Refetch</button>`;
  if (st.state === 'running') {
    setColStatus('cur-status', st.message || 'Fetching…');
    list.innerHTML = '';
    updateCurAdd(ls);
    return;
  }
  if (st.state === 'error') {
    setColStatus('cur-status', 'Error: ' + (st.error || 'failed'), true);
    list.innerHTML = '<button class="small" data-act="retry">Retry</button>';
    updateCurAdd(ls);
    return;
  }
  // drop stale ticks, then filter + sort
  for (const id of [...col.curSel]) if (!st.recordings.some((r) => r.id === id)) col.curSel.delete(id);
  const q = $('cur-filter').value.trim().toLowerCase();
  const sorter = CUR_SORTERS[$('cur-sort').value] || CUR_SORTERS.releases;
  const inDs = datasetByMbid();
  const rows = st.recordings
    .filter((r) => !q || [r.artist, r.album, r.date, r.title].filter(Boolean).join(' ').toLowerCase().includes(q))
    .sort(sorter);
  const already = st.recordings.filter((r) => inDs.has(r.id)).length;
  setColStatus('cur-status',
    `${rows.length}${q ? ` of ${st.recordings.length}` : ''} recordings · ${already} already in the dataset · ` +
    'tick the ones to add; “Appear.” = number of releases the recording appears on');
  list.innerHTML = recHeaderHtml(true) +
    rows.map((r) => recRowHtml(r, { check: true, sel: col.curSel.has(r.id), inSong: inDs.get(r.id), workTitle: w.title })).join('');
  updateCurAdd(ls);
}
function updateCurAdd(ls) {
  const n = col.curSel.size;
  $('cur-add').textContent = `Add selected (${n})`;
  $('cur-add').disabled = !n || !ls || !ls.musicbrainz_id;
}
$('cur-head').addEventListener('click', (ev) => {
  const act = ev.target.closest('[data-act]');
  const ls = currentLs();
  if (!act || !ls) return;
  if (act.dataset.act === 'gowork') { col.step = 'work'; renderLsSteps(ls); }
  else if (act.dataset.act === 'refetch') ensureRecordings(ls.musicbrainz_id, true);
});
$('cur-list').addEventListener('click', (ev) => {
  const ls = currentLs();
  if (!ls) return;
  const act = ev.target.closest('[data-act="retry"]');
  if (act) { ensureRecordings(ls.musicbrainz_id, true); return; }
  const row = ev.target.closest('.rec[data-rid]');
  if (!row) return;
  const rid = row.dataset.rid;
  const inSong = datasetByMbid().get(rid);
  if (inSong) {                     // already in the dataset -> jump to that song
    lib.selectedSong = inSong.id;
    renderLibrary();
    return;
  }
  if (col.curSel.has(rid)) col.curSel.delete(rid); else col.curSel.add(rid);
  renderCurate(ls);
});
$('cur-filter').addEventListener('input', () => { const ls = currentLs(); if (ls) renderCurate(ls); });
$('cur-sort').addEventListener('change', () => { const ls = currentLs(); if (ls) renderCurate(ls); });
$('cur-clear').addEventListener('click', () => { col.curSel = new Set(); const ls = currentLs(); if (ls) renderCurate(ls); });

$('cur-add').addEventListener('click', async () => {
  const ls = currentLs();
  const st = ls && col.recs[ls.musicbrainz_id];
  if (!st || st.state !== 'done' || !col.curSel.size) return;
  const picks = st.recordings.filter((r) => col.curSel.has(r.id));
  $('cur-add').disabled = true;
  const inherited = inheritedFromLs(ls);
  let added = 0;
  const skipped = [];
  for (const r of picks) {
    $('cur-add-status').textContent = `adding ${added + skipped.length + 1} / ${picks.length}…`;
    try {
      const resp = await fetch('/api/songs/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          standard: ls.title || '', artist: r.artist || '', album: r.album || '',
          musicbrainz_id: r.id, ...inherited,
        }),
      });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok || !d.ok) throw new Error(d.error || `HTTP ${resp.status}`);
      added++;
    } catch (err) {
      skipped.push(`${r.artist}: ${err.message}`);
    }
  }
  col.curSel = new Set();
  await loadSongs();
  $('cur-add-status').textContent =
    `added ${added} song${added === 1 ? '' : 's'}` + (skipped.length ? ` · ${skipped.length} skipped (see console)` : '');
  if (skipped.length) console.warn('curation: skipped', skipped);
  renderLibrary();     // songs list (filtered by this standard) + this pane
});

// ---- ③ YouTube search / preview / crawl -----------------------------------------
function resetYt(song) {
  col.songId = song.id;
  col.yt = { results: [], preview: null, busy: false };
  $('yt-q').value = [song.artist, song.standard].filter(Boolean).join(' ');
  $('yt-results').innerHTML = '';
  $('yt-frame').src = 'about:blank';
  setColStatus('yt-status', '');
  $('yt-crawl-status').textContent = lib.refreshBusy ? $('lib-refresh-status').textContent : '';
}
function renderYt(song) {
  const yt = (song.yt_id || '').trim();
  $('yt-current').innerHTML = yt
    ? `Current video: <a href="https://www.youtube.com/watch?v=${encodeURIComponent(yt)}" target="_blank" rel="noopener">${escapeHtml(yt)}</a>` +
      `<span class="muted"> · ${song.has_audio ? `audio crawled (${escapeHtml(fmtDur(song.audio_length))})` : 'audio not crawled yet'}</span>` +
      `<button class="small" data-act="preview-current">Preview</button>`
    : 'No video assigned yet — search below, preview a result, then <b>Use this video</b>.';
  // results
  const box = $('yt-results');
  box.innerHTML = col.yt.results.map((v) =>
    `<div class="vid${col.yt.preview && col.yt.preview.id === v.id ? ' sel' : ''}${v.id === yt ? ' current' : ''}" data-vid="${escapeHtml(v.id)}">` +
    `<img src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy" />` +
    `<div><div class="t">${escapeHtml(v.title)}</div><div class="c">${escapeHtml(v.channel)}${v.id === yt ? ' · <span class="in-tag">current</span>' : ''}</div></div>` +
    `<div class="dur">${v.duration ? fmtLen(v.duration * 1000) : ''}</div></div>`
  ).join('');
  // preview
  const pv = col.yt.preview;
  $('yt-preview').classList.toggle('hidden', !pv);
  if (pv) {
    const src = `https://www.youtube.com/embed/${encodeURIComponent(pv.id)}`;
    if (!$('yt-frame').src.startsWith(src)) $('yt-frame').src = src;
    $('yt-preview-title').textContent = pv.title || pv.id;
    $('yt-use').disabled = pv.id === yt;
    $('yt-use').textContent = pv.id === yt ? 'Current video ✓' : 'Use this video';
  }
  $('yt-crawl').textContent = song.has_audio ? '↻ Re-crawl audio' : '⬇ Crawl audio';
  setCrawlButtons();
}
async function searchYt() {
  const song = currentLibSong();
  if (!song || col.yt.busy) return;
  const q = $('yt-q').value.trim();
  if (!q) return;
  col.yt.busy = true;
  $('yt-search').disabled = true;
  setColStatus('yt-status', 'Searching YouTube (yt-dlp)…');
  try {
    const r = await fetch(`/api/yt/search?q=${encodeURIComponent(q)}&n=12`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    if (currentLibSong() !== song) return;
    col.yt.results = d.results || [];
    setColStatus('yt-status', col.yt.results.length
      ? `${col.yt.results.length} results · click one to preview it`
      : 'No results.');
  } catch (err) {
    setColStatus('yt-status', 'Error: ' + err.message, true);
  } finally {
    col.yt.busy = false;
    $('yt-search').disabled = false;
    const s = currentLibSong();
    if (s) renderYt(s);
  }
}
$('yt-search').addEventListener('click', searchYt);
$('yt-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchYt(); } });
$('yt-results').addEventListener('click', (ev) => {
  const row = ev.target.closest('.vid[data-vid]');
  const song = currentLibSong();
  if (!row || !song) return;
  const v = col.yt.results.find((x) => x.id === row.dataset.vid);
  col.yt.preview = v ? { id: v.id, title: v.title } : { id: row.dataset.vid, title: '' };
  renderYt(song);
});
$('yt-current').addEventListener('click', (ev) => {
  const song = currentLibSong();
  if (!song || !ev.target.closest('[data-act="preview-current"]')) return;
  col.yt.preview = { id: song.yt_id, title: `current video · ${song.yt_id}` };
  renderYt(song);
});
$('yt-use').addEventListener('click', async () => {
  const song = currentLibSong();
  const pv = col.yt.preview;
  if (!song || !pv || pv.id === song.yt_id) return;
  const old = song.yt_id;
  song.yt_id = pv.id;
  if (state.current && state.current.id === song.id && state.current !== song) state.current.yt_id = pv.id;
  const ok = await postMetaFields(song.id, { yt_id: pv.id }, $('lib-song-status'));
  if (!ok) {   // e.g. that video already belongs to another song
    song.yt_id = old;
    if (state.current && state.current.id === song.id && state.current !== song) state.current.yt_id = old;
    setColStatus('yt-status', $('lib-song-status').textContent, true);
  } else {
    setColStatus('yt-status', `Video ${pv.id} assigned — now crawl the audio.`);
  }
  renderLibSongInfo(song);
  renderYt(song);
});
$('yt-crawl').addEventListener('click', () => startLibCrawl(currentLibSong()));
