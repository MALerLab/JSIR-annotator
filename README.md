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

- `metadata.json` — song list (audio ↔ beats pairing + metadata)
- `audio/*.mp3`   — recordings
- `beats/*.txt`   — beat times, one float (seconds) per line
- `sections/*.csv` — **output**: section labels (`time,name`), one file per song

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
- **Sections**: press **S** (or *+ Section*) while playing to drop a section at
  the playhead — its start snaps to the nearest beat and it auto-fills to the
  next section (or end of track). Name it in the inspector. Drag a section's top
  tab to move its start (snaps on release).
- **Zoom** with −/+; **Follow** auto-scrolls during playback.
- **Save** writes `beats/<name>.txt` and `sections/<name>.csv`.

## Notes

- Section ends are implicit (each section runs to the next one's start), so
  sections always tile the track with no gaps to manage.
- The first time a beat file is overwritten, the original madmom output is
  backed up to `beats/<name>.txt.orig`.
- The metronome uses a synthesised click. To use a real sample, run
  `loadClickSample('/static/click.wav')` in the browser console (or wire it into
  `app.js`).

total length: 390,882 seconds (108h 34m 42s) => 6,514.7 minutes