# Jazz Beat & Section Annotator

Web tool for reviewing madmom beat tracking and annotating song-structure
sections on jazz recordings.

## Run

```bash
pip install flask          # or:  pipenv install && pipenv shell
python app.py
# open http://127.0.0.1:5000
```

The dataset is read from this folder:

- `metadata.json` — song list (audio/beats/chords pairing + metadata)
- `audio/*.wav`   — recordings
- `beats/*.txt`   — one beat per line: `<time>` for a normal beat, or
  `<time>\t1` for a downbeat. Bare-float files (original madmom output) load as
  all-normal, so old files stay compatible.
- `chords/*.csv`  — chord events (`time,chord`); each lasts until the next start
- `sections/*.csv` — **output**: section labels (`time,name,beats_per_measure`),
  one file per song (`beats_per_measure` blank = use the song's time signature)
- `metadata.json` also stores the annotated **key** per song (`"key"` field,
  e.g. `"D minor"`; absent = None). Edited from the right-hand Song Info panel
  and written back in place (a one-time `metadata.json.orig` backup is made on
  the first edit).

## Using it

- Pick a song in the left sidebar. The waveform loads with green beat lines
  overlaid; saved sections (if any) appear as translucent rectangles with a
  label tab along the top.
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
- **Multi-select events**: with a section, structure, or chord selected, press
  **A** to select all following events of that kind (the anchor included). The
  multi panel lets you delete them together. (**A** with a beat selected or
  nothing selected still selects all beats after the playhead.)
- **Lane headers**: the timeline shows sticky left-edge labels — **Structure**,
  **Sections**, **Chords** — that stay put as you scroll; event names are kept
  clear of them.
- **Chords**: shown in the strip between the ruler and the waveform, coloured by
  chord name (runs of the same chord read as one band). Click a chord block to
  select it, then edit the name / start time in the inspector; drag a block to
  move its start (snaps to beat on release); press **C** (or *+ Chord*) to add
  one at the playhead; **Del** removes the selected chord.
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
  the recording key (toggle with the *transpose* checkbox, default on). See
  `jsd/chords.py` for the transposition/key-comparison helpers.
- **Song Info panel** (right): the **Key** dropdown plus editable text fields
  (Standard, Artist, Album, Instrumentation, Tempo Class, Rhythm Feel, Time
  Signature, YouTube ID, MusicBrainz ID) and the integer **Number of Bars**
  (`num_bars`). Edits save to `metadata.json` on blur (`num_bars` is an int).
  `tempo_class`/`rhythm_feel`/`time_signature` were seeded from the lead sheets.
  Links to *Open on YouTube* and *Open in MusicBrainz* appear below the fields.
- **Refresh audio**: if a song was crawled from the wrong video, fix the
  **YouTube ID** field then click *↻ Refresh audio*. A background job re-downloads
  the audio (yt-dlp → WAV), re-runs beat tracking (madmom `DBNBeatTracker`),
  writes `audio/<id>.wav` + `beats/<id>.txt`, and drops the song's now-stale
  chord/section labels. Progress shows live in the panel; the canvas reloads when
  done. Work happens in a temp dir and is only committed on success, so a failure
  (bad ID, network error) leaves the existing files untouched. Requires the app
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