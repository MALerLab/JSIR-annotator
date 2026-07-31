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
- `sections/*.csv` — **output**: section labels (`time,name`), one file per song
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
  all at once. *Fill ×4* subdivides the gap between each selected pair by adding
  three evenly-spaced beats.
- **Downbeats**: a beat can be flagged a downbeat (drawn amber, higher-pitched
  metronome click). Toggle it with the checkbox in the beat inspector. Creating
  a section re-grids downbeats from its start beat: every 4th beat becomes a
  downbeat (4/4), clearing others in that range. *Clear ↧* wipes all downbeats
  in the song. Downbeat flags are saved into the beat file. The **Downbeats
  only** toolbar toggle hides non-downbeat lines (visual only — data and
  metronome clicks are unchanged); it resets to off on song load.
- **Navigation**: the **◀◀ / ▶▶** buttons jump the playhead by *N* bars
  (4×N beats, 4/4 assumed); set *N* in the adjacent input (defaults to the
  song's `num_bars` on load). *◀ Sec / Sec ▶* jump between sections.
- **Zoom**: mouse-wheel over the waveform (anchored at the cursor), or −/+
  (range 4–800 px/s). **Alt+wheel** scrolls horizontally instead of zooming.
  When zoomed out past the audio's length, the waveform ends where the audio
  ends and the rest of the canvas is blank.
- **Volume**: sliders at the bottom of the Song Info panel set song volume
  (0–150%, >100% amplifies) and metronome volume (0–100%) independently; both
  reset to 100% on song load.
- **Deselect**: click empty space, press **Esc**, or the *Deselect* button.
- **Sections**: press **S** (or *+ Section*) while playing to drop a section at
  the playhead — its start snaps to the nearest beat and it auto-fills to the
  next section (or end of track). Name it in the inspector — the name field is a
  combobox with preset labels (head:horn/piano/vocal, solo:horn/piano/bass,
  last, exchange, exclude) plus autocomplete; you can still type anything. Drag a
  section's top tab to move its start (snaps on release). Each section's label
  shows its length in **bars** (4/4) and stays pinned to the left edge when its
  start scrolls off-screen.
- **Chords**: shown in the strip between the ruler and the waveform, coloured by
  chord name (runs of the same chord read as one band). Click a chord block to
  select it, then edit the name / start time in the inspector; drag a block to
  move its start (snaps to beat on release); press **C** (or *+ Chord*) to add
  one at the playhead; **Del** removes the selected chord.
- **Song Info panel** (right): the **Key** dropdown plus editable text fields
  (Standard, Artist, Album, Instrumentation, YouTube ID, MusicBrainz ID) and the
  integer **Number of Bars** (`num_bars`). Edits save to `metadata.json` on blur
  (`num_bars` is stored as an int).
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