# Jazz Beat & Section Annotator

Web tool for reviewing madmom beat tracking and annotating song-structure
sections on jazz recordings.

## Run

```bash
pip install flask          # or:  pipenv install && pipenv shell
python app.py
# open http://127.0.0.1:5000
```

The app has two tabs: **Library** (default — organize standards & songs, edit
lead-sheet chords and high-level metadata, crawl new audio, track completion)
and **Edit** (the waveform/beat/section/chord annotation editor).

The dataset is read from this folder:

- `lead_sheets.json` — the jazz standards: title, key, signature, tempo/feel,
  `tonality`, `chords_per_measure`, `chord_changes` (one string per measure),
  optional `coda`. Chords are written in **Harte notation** —
  `{root}:{shorthand}({extensions})/{bass}`, e.g. `F:min7`, `C:7(#9)`,
  `G:sus4(b7)`, `C:maj7/3` — with `N` for no chord and `%` for "hold the
  previous chord". The bass after `/` is an interval above the root, not a note
  name, so transposing a chord only moves its root. Fully editable from the
  Library tab (saved in real time; a one-time `.orig` backup is made on first
  edit).
- `metadata.json` — song list (audio/beats/chords pairing + metadata), incl.
  the boolean `completed` status per song and a stable uuid4 `id` per song
  (assigned once by the app; songs added from MusicBrainz have no audio or
  `yt_id` yet, so the file stem cannot serve as identity)
- `cache/` — disposable working data for the Library's collection steps
  (MusicBrainz recording lists for linked works, in-flight crawl downloads).
  Safe to delete at any time; it is git-ignored and swept at start-up.
- `audio/*.wav`   — recordings
- `beats/*.txt`   — one beat per line: `<time>` for a normal beat, or
  `<time>\t1` for a downbeat. Bare-float files (original madmom output) load as
  all-normal, so old files stay compatible.
- `chords/*.csv`  — chord events (`time,chord`); each lasts until the next start
- `sections/*.csv` — **output**: section labels (`time,name,beats_per_measure`),
  one file per song (`beats_per_measure` blank = use the song's time signature)
- `segments/*.csv` — **output**: stretches of a song whose beats and chords
  are usable as training material (`start,end`, one row per segment). Derived
  from the sections (see *Valid segments* below); a song with no file has no
  segment annotation yet.
- `metadata.json` also stores the annotated **key** per song (`"key"` field,
  e.g. `"D minor"`; absent = None). Edited from the right-hand Song Info panel
  and written back in place (a one-time `metadata.json.orig` backup is made on
  the first edit).
- **Tonality** (`tonality`) is carried by both lead sheets and songs and names
  the harmonic idiom of the standard: `functional`, `blues` or `modal`. Picked
  from a dropdown in Lead Sheet Info / Song Info (blank clears it); everything
  currently defaults to `functional`.

## Library tab

- **Lead Sheets** and **Songs** lists side by side; selecting a lead sheet
  filters the Songs list to that standard (matched case-insensitively between
  the lead sheet `title` and the song `standard`). *+ New* adds a standard;
  *+ Add* adds a song by YouTube ID (which becomes its file-name stem — fill in
  its fields, then *Refresh audio* to crawl it). Lead sheets and songs can be
  deleted (song deletion removes only the metadata entry; files stay on disk).
- Both lists (and the Edit tab's sidebar) have a **filter** box and a **sort**
  row: by name, by artist (songs only) or by date added (the order entries sit
  in `metadata.json` / `lead_sheets.json`), ascending or descending via the
  arrow button. Default is name ascending. Names compare case- and
  accent-insensitively, with numbers ordered numerically.
- **Inspector** (right): with nothing selected it shows dataset **stats**
  (lead-sheet/song counts, completion, total & completed audio duration).
  Selecting a lead sheet opens the **Lead Sheet Info** editor: metadata fields,
  a **chords-per-measure** value (lowering it confirms, then cuts the trailing
  slots of every measure), and a spreadsheet-style **chord grid** — one row per
  measure, one cell per beat slot; empty cells revert to `%`; Tab moves along
  the row, Enter jumps to the next measure's first cell (creating a new measure
  at the end); everything saves to `lead_sheets.json` in real time. Saved edits
  are pushed straight into the Edit tab's working copy (and it re-reads the lead
  sheet whenever you switch back), so chord insertion always uses the latest
  progression. A **coda** grid can be added/removed. Selecting a song opens
  **Song Info** (same fields as the Edit tab, plus links, Refresh audio, and the
  completion toggle).
- **Assign** (Lead Sheet Info): Key, Time Signature, Tempo Class, Rhythm Feel
  and Tonality each carry an *Assign* button that copies that value onto every
  song of the standard (a confirmation names the field, the value and how many
  songs it will touch). The lead sheet's key spelling is translated to the song
  vocabulary on the way — `Ab-maj` becomes `Ab maj`, sharps folded to flats —
  and the same values are what a curated song inherits when it is added.
- **Completion**: each song has a `completed` flag. The green **Mark as
  complete** / red **Mark as incomplete** button (in both tabs' Song Info)
  toggles it; completed songs show a green dot in every songs list. Songs that
  have been added but not crawled yet carry a *no audio* tag and are dimmed /
  unselectable in the Edit tab.

### Collection pane (right-most column)

The three data-collection steps of the original `js-dataset-crawler` pipeline,
done by hand instead of by composer filter + LLM. The pane follows the current
selection.

1. **MusicBrainz work** (lead sheet selected) — search MusicBrainz works with an
   editable query (defaults to the title; plain text matches the work title,
   MusicBrainz/Lucene syntax such as `artist:Rollins` is passed through).
   Results list title, composer/lyricist, disambiguation and the **number of
   recordings**, sorted by that number. Click a work to expand its recordings
   (artist · album, date, length, appearances) and **Link** it: the work id is
   stored on the lead sheet as `musicbrainz_id` and its composer(s) as
   `composer` (both shown/editable in Lead Sheet Info; *Unlink* removes the
   link). Requests are throttled to MusicBrainz's 1 req/s and retried when it
   answers "server busy".
2. **Curate recordings** (lead sheet selected, work linked) — every recording of
   the linked work with artist, album (earliest dated release), date, length and
   **appearances** (how many releases it is on — a good notability signal), with
   filter and sort. Recordings already in the dataset are marked (clicking one
   jumps to that song). Tick recordings and **Add selected**: each becomes a
   song with `standard`, `artist`, `album`, `musicbrainz_id` (recording id), and
   inherits `key`, `num_bars` (= number of chord-change lines), `tempo_class`,
   `rhythm_feel`, `time_signature`, `tonality` from the lead sheet. The
   recording list is cached under `cache/mb/<work>.json` while the work stays
   linked (*Refetch* forces a reload).
3. **Crawl audio** (song selected) — search YouTube via yt-dlp (default query
   "{artist} {standard}"), preview a result in the embedded player, **Use this
   video** to store its `yt_id`, then **Crawl audio** to download the WAV and
   run beat tracking (same pipeline as *Refresh audio*; downloads are staged in
   `cache/crawl/` and moved into `audio/` + `beats/` only on success). The step
   also works for existing songs to swap their video.

## Edit tab

- Pick a song in the left sidebar (filter and sort as in the Library tab).
  The waveform loads with green beat lines overlaid; saved sections (if any)
  appear as translucent rectangles with a label tab along the top.
- **Space** play/pause · **Stop** resets to start. A white playhead tracks
  position; a metronome click fires on each beat (toggle in the toolbar).
- **Seek**: click anywhere on the waveform.
- **Beats**: click/drag a beat line to select & move it; **Shift+click** an
  empty spot or press **B** to add a beat at the playhead; **Del** removes the
  selected beat. Fine-tune the exact time in the inspector below.
  - **Nudge**: with beat(s) selected, ←/→ moves them ±20 ms (Shift = ±100 ms).
  - *Beats ×2* inserts a beat at every midpoint (fixes half-rate tracking).
  - *Beats ÷2* keeps the **selected** beat plus every other one (the anchor
    decides which half survives).
  - Both operate on the **loop region** when one is set (beats outside are left
    untouched), otherwise on the whole song. With a loop region, ÷2 anchors on
    the selected beat if it's inside, else the region's first beat.
- **Multi-select beats**: **double-click-drag on the ruler** to make a loop
  region (selects every beat inside; playback loops within it; double-click the
  ruler again to clear), or **Shift-click** beats to build a selection. With
  several selected you can drag the group, nudge, delete, or toggle downbeat for
  all at once (**Ctrl+D** toggles downbeat for the selection). *Fill ×4* (or the
  **2 / 3 / 4** keys) subdivides the gap between each selected pair into 2, 3, or
  4 evenly-spaced parts.
- **Downbeats**: a beat can be flagged a downbeat (drawn amber, higher-pitched
  metronome click). Toggle it with the checkbox in the beat inspector. Creating
  a section re-grids downbeats from its start beat: every Nth beat (N = the
  section's beats/measure) becomes a downbeat, clearing others. *Clear ↧* wipes all downbeats
  in the song. Downbeat flags are saved into the beat file. The **Downbeats
  only** toolbar toggle hides non-downbeat lines (visual only — data and
  metronome clicks are unchanged); it resets to off on song load.
- **Navigation**: the **◀◀ / ▶▶** buttons (or **Q / E**) jump the playhead by
  *N* bars; set *N* in the adjacent input (defaults to the song's `num_bars` on
  load). *◀ Sec / Sec ▶* — or **J / K** — jump between sections.
- **Zoom**: mouse-wheel over the waveform (anchored at the cursor), or −/+
  (range 4–800 px/s). **Alt+wheel** scrolls horizontally instead of zooming.
  When zoomed out past the audio's length, the waveform ends where the audio
  ends and the rest of the canvas is blank.
- **Volume**: sliders at the bottom of the Song Info panel set song volume
  (0–150%, >100% amplifies) and metronome volume (0–100%) independently; both
  reset to 100% on song load. A **Beat opacity** slider (0–100%) fades the beat
  lines and, unlike the volumes, **persists** across song loads.
- **Deselect**: click empty space, press **Esc**, or the *Deselect* button.
- **Sections**: press **S** (or *+ Section*) while playing to drop a section at
  the playhead — its start snaps to the nearest beat and it auto-fills to the
  next section (or end of track). Name it in the inspector — the name field is a
  combobox with preset labels (head:horn/piano/vocal, solo:horn/piano/bass,
  last, exchange, exclude) plus autocomplete; you can still type anything. Drag a
  section's top tab to move its start (snaps on release). Each section's label
  shows its length in **bars** and stays pinned to the left edge when its start
  scrolls off-screen. A section has a **beats/measure** value (defaults to the
  numerator of the song's time signature, editable per section) that drives its
  bar count, its downbeat grid, and chord insertion; *Insert downbeats* re-grids
  downbeats for the section's span only. When beats/measure differs from the
  lead sheet's bar length (e.g. a 3-beat section against 4/4 bars), chord
  insertion fits each bar's distinct chords into the measure (3-beat: 1 chord→
  beat 1, 2→beats 1&3, 3→each beat, 4→first three).
- **Structure**: a second event lane (above Sections) that behaves exactly like
  sections (add with **T** or *+ Structure*, name/move/delete, bars length) but
  has no chord-insertion. Stored separately in `structure/<name>.csv` (same
  `time,name` format); a song with no structure file yet falls back to a copy of
  its sections until you edit and save. **R** (or the *Sec→Struct* toolbar
  button) copies all sections into the structure lane at once.
- **Valid segments**: the spans whose beat/chord annotations are relevant for
  training (beat tracking / chord estimation) — each runs from the first
  section that is *not* an intro, outro, bass solo or `exclude` up to the next
  one that is; a span reaching the end of the song stops at the last downbeat,
  so the trailing partial bar is left out. *⌗ Generate segments* in the Song
  Info panel (re)derives them for the song and writes `segments/<name>.csv` —
  pending editor edits are saved first, because the derivation runs on the
  server from the saved sections and beats. Segments get no lane of their own:
  with the **Valid segments** toolbar toggle on (the default for any song that
  has a segments file) everything outside them is **greyed out** — a
  semi-transparent darkening over the chord lane and the beat lines, with the
  waveform still drawn on top at full contrast. A file with no rows means
  "nothing here is valid" and dims the whole song; a song with no file dims
  nothing and the toggle is disabled.
- **Multi-select events**: with a section, structure, or chord selected, press
  **A** to select all following events of that kind (the anchor included). The
  multi panel lets you delete them together. (**A** with a beat selected or
  nothing selected still selects all beats after the playhead.)
- **Lane headers**: the canvas keeps a reserved left gutter labelling each lane
  — **Structure**, **Sections**, **Chords**, **Audio**. The timeline starts to
  the right of it, so the headers never cover events or the waveform. The
  waveform itself is drawn last (over the section/structure tints and the beat
  lines) in near-white so it stays readable.
- **Chords**: shown in the strip between the ruler and the waveform, coloured by
  chord name (runs of the same chord read as one band). Click a chord block to
  select it, then edit the name / start time in the inspector; drag a block to
  move its start (snaps to beat on release); press **C** (or *+ Chord*) to add
  one at the playhead; **Del** removes the selected chord.
  - **Shift-click** another chord to select the whole **range** between it and
    the current one (**A** still selects every chord from here on).
  - **Ctrl+C / Ctrl+V** copy and paste the selected chords. The copy stores each
    chord as a *beat offset* from the first one, so the paste lands on the beat
    nearest the playhead and re-aligns the rest onto the following beats —
    whatever chords already sit in that span are overwritten.
  - **Tab** in the chord-name box jumps to the next chord in time and selects its
    name (**Shift+Tab** for the previous one), so a progression can be typed
    straight through without the mouse.
- **Chord-progression insertion**: canonical progressions live in
  `lead_sheet_chords.json` (looked up by title, performer ignored). When a song
  loads, the Song Info panel shows the lead-sheet key and whether *chords* /
  *coda* are available. With a **section selected**, the section inspector offers:
  *Insert chords* (fills the section from the top of the progression, looping to
  fill — also **Alt+C** while the section is selected), *Insert last* (back-aligns so the section's last bar matches the
  progression's last bar — only enabled when the section is shorter than the lead
  sheet), and *Insert coda* (fills with the coda progression — only when one
  exists). Each maps progression beats onto the section's beats (`%` = held
  chord, no new event) and overwrites existing chords in the section's span. If
  the recording's key differs from the lead sheet's, chords are **transposed** to
  the recording key (toggle with the *transpose* checkbox, default on).
  Transposition shifts the note *letter* as well as the pitch, so the spelling
  stays musical: Ab → Db turns `F:min7` into `Bb:min7`, not the enharmonic
  `A#:min7`, and a lead sheet in Gb inserted against a song in F# is simply
  respelled. Distant key pairs that would need a double accidental
  (Ab's `B:maj7` in F# is strictly `G##:maj7`) fall back to a plain spelling of
  the same pitch, sharp or flat according to the recording's key.
  `jsd/chords.py` holds the same logic for offline use (`transpose_shift`,
  `transpose_harte_chord`, `transpose_progression`) plus a Harte parser
  (`parse_harte_chord`) covering the lead sheets, the chord events and the
  Consonance ACE `.lab` inferences; `static/app.js` mirrors the transposition
  half of it.
- **Song Info panel** (right): the **Key** and **Tonality** dropdowns plus
  editable text fields (Standard, Artist, Album, Instrumentation, Tempo Class,
  Rhythm Feel, Time Signature, YouTube ID, MusicBrainz ID) and the integer
  **Number of Bars**
  (`num_bars`). Edits save to `metadata.json` on blur (`num_bars` is an int).
  `tempo_class`/`rhythm_feel`/`time_signature` were seeded from the lead sheets.
  Links to *Open on YouTube* and *Open in MusicBrainz* appear below the fields.
- **Refresh audio**: if a song was crawled from the wrong video, fix the
  **YouTube ID** field then click *↻ Refresh audio*. A background job re-downloads
  the audio (yt-dlp → WAV), re-runs beat tracking (madmom `DBNBeatTracker`),
  writes `audio/<id>.wav` + `beats/<id>.txt` (and updates `audio_length`), and
  drops the song's now-stale chord/section labels (and the segments derived from
  them). Progress shows live in the
  panel; the canvas reloads when done. Work happens in `cache/crawl/` and is only
  committed on success, so a failure (bad ID, network error) leaves the existing
  files untouched. Requires the app
  to run in the project venv (with `yt-dlp` + `madmom` installed). Note: yt-dlp
  now prefers a JS runtime for YouTube — install `deno` if downloads start
  failing.
- **Zoom** with −/+; **Follow** auto-scrolls during playback.
- **Save** writes `beats/<name>.txt`, `sections/<name>.csv`, and
  `chords/<name>.csv` (the original chord file is backed up to `.csv.orig` on
  first edit).

## Notes

- Section ends are implicit (each section runs to the next one's start), so
  sections always tile the track with no gaps to manage.
- The first time a beat file is overwritten, the original madmom output is
  backed up to `beats/<name>.txt.orig`.
- The metronome uses a synthesised click. To use a real sample, run
  `loadClickSample('/static/click.wav')` in the browser console (or wire it into
  `app.js`).

total length: 390,882 seconds (108h 34m 42s) => 6,514.7 minutes