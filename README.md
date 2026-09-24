# JSIR Annotatior

A browser-based tool for building and editing [JSIR](https://github.com/MALerLab/JSIR), a dataset of jazz standard recordings with audio-aligned beats, downbeats, chords and song structure. It runs as a small local Flask server, and every annotation is a plain-text file in this repository.

## Requirements

- Python > 3.11
- [ffmpeg](https://ffmpeg.org/): used by yt-dlp to convert downloads to WAV
- [Deno](https://deno.com/) (recommended): yt-dlp needs a JavaScript runtime for YouTube

You need only Flask to view and edit existing annotations. yt-dlp, madmom and ffmpeg are needed to download audio and run beat tracking.

## Setup

```bash
git clone https://github.com/issyun/js-dataset.git
cd js-dataset
pipenv install        # the Pipfile pins Python 3.11.12
pipenv shell
```

Or, without pipenv:

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install flask yt-dlp tqdm "madmom @ git+https://github.com/CPJKU/madmom.git"
```

madmom is installed from GitHub because its PyPI release does not support recent Python versions.

## Sourcing audio

Audio is not stored in the repository (about 70 GB for all songs). Each song's `yt_id` in `metadata.json` identifies the YouTube upload that its annotations are timed against. For example, this script will download any missing recordings into `audio/`:

```bash
python - <<'EOF'
import json, subprocess, sys
from pathlib import Path

for song in json.load(open("metadata.json")):
    yt_id = song.get("yt_id")
    wav = Path("audio") / f"{yt_id}.wav"
    # add `and song.get("completed")` to fetch only fully annotated songs
    if yt_id and not wav.exists():
        subprocess.run([sys.executable, "-m", "yt_dlp", "-x", "--audio-format", "wav",
                        "--no-playlist", "--extractor-args", "youtube:player_client=android",
                        "-o", str(wav.with_suffix(".%(ext)s")),
                        f"https://www.youtube.com/watch?v={yt_id}"])
EOF
```

> [!WARNING]
> Do not use the in-app **Refresh audio** or **Crawl audio** buttons to fetch audio for songs that are already annotated. They re-run beat tracking and **delete** the song's chords, sections, structure and segments. Use them only for new songs or to replace a wrong video.

If a video is no longer available, its annotations cannot be reused with a different upload unless you check them again against the new audio.

## Run

```bash
python app.py
```

Open <http://127.0.0.1:5000>. The server listens on localhost only. On a remote machine, forward the port with `ssh -L 5000:127.0.0.1:5000 <host>`.

## Using the tool

The app has two tabs, **Library** and **Edit**.

### Library

- **Lead Sheets**: one entry per jazz standard. Selecting one filters the Songs list and opens its editor, which holds the key, time signature, tempo class, rhythm feel, tonality and a chord grid with one row per bar. The **Assign** buttons next to the key, time signature, tempo class, rhythm feel and tonality copy that value to every song of the standard.
- **Songs**: one entry per recording. Selecting one shows its metadata and a **Mark as complete** toggle.
- **Collection pane** (right), for adding new material:
  1. **MusicBrainz work**: search for the standard's MusicBrainz work and link it.
  2. **Curate recordings**: tick recordings of that work and click **Add selected** to create songs. New songs inherit the lead sheet's key, meter and feel.
  3. **Crawl audio**: search YouTube, click **Use this video**, then **Crawl audio** to download the WAV and run madmom beat tracking.

### Edit

Pick a song in the sidebar. Songs without audio are greyed out. From top to bottom, the canvas shows the Structure, Sections and Chords lanes, then thewaveform with beat lines.

A typical annotation pass:

1. **Beats**: play the song with the metronome click and correct madmom's beats. You can drag, add or delete beats, and **Beats ×2** / **÷2** fix half- or double-tempo tracking.
2. **Sections**: press **S** at the start of each part and name it, choosing from presets such as `intro`, `head:horn`, `solo:piano`, `trade`, `exclude` and `outro`, or typing any label. Adding a section marks every *N*th beat from its start as a downbeat (*N* = its beats per measure).
3. **Chords**: select a section and click **Insert chords** (Alt+C) to fill it from the lead sheet, transposed to the recording's key. Then correct individual chords.
4. **Structure**: press **R** to copy the sections into the Structure lane, then adjust them.
5. In the Song Info panel, click **Generate segments**, then **Mark as complete**.

Edits in this tab stay in the browser until you click **Save** (Ctrl+S). Edits in Song Info and the Library tab are saved immediately. The first time abeat file, chord file, `metadata.json` or `lead_sheets.json` is overwritten, theoriginal is kept as a `.orig` backup.

#### Controls

Keyboard shortcuts apply only when no text field has focus.

| Input | Action |
| --- | --- |
| Space | Play / pause |
| Click waveform | Seek |
| Wheel / Alt+wheel | Zoom / scroll |
| Q / E | Jump back / forward *N* bars (set *N* in the toolbar) |
| J / K | Previous / next section |
| Double-click-drag on ruler | Set a loop region and select its beats (double-click to clear) |
| B, or Shift+click an empty spot | Add a beat |
| Shift+click beats | Add beats to the selection |
| ← / → | Nudge selected beats ±20 ms (with Shift: ±100 ms) |
| D / H | Beats ×2 / ÷2 (limited to the loop region if one is set) |
| 2 / 3 / 4 | Subdivide the gaps between selected beats |
| Ctrl+D | Toggle downbeat on the selected beats |
| S / T / C | Add a section / structure event / chord at the playhead |
| R | Copy sections into the Structure lane |
| Alt+C | Insert lead-sheet chords into the selected section |
| A | Select all later events of the selected kind (with nothing selected: all beats after the playhead) |
| Ctrl+C / Ctrl+V | Copy / paste chords, pasting at the beat nearest the playhead |
| Tab / Shift+Tab (in chord name box) | Move to the next / previous chord |
| Del | Delete the selection |
| Esc | Deselect |
| Ctrl+Z / Ctrl+S | Undo / save |

## Data layout

Files are named after the song's `yt_id`, and all times are in seconds.

| Path | Contents |
| --- | --- |
| `metadata.json` | One entry per recording: `id`, `yt_id`, `standard`, `artist`, `album`, `musicbrainz_id`, `key`, `time_signature`, `tempo_class`, `rhythm_feel`, `tonality`, `num_bars`, `audio_length`, `completed`, and `files` (paths to the files below) |
| `lead_sheets.json` | One entry per standard: `title`, `key`, `signature`, `tempoclass`, `rhythmfeel`, `tonality`, `chord_changes` (one string per bar), optional `coda`, `musicbrainz_id`, `composer` |
| `audio/*.wav` | Recordings (not in git) |
| `beats/*.txt` | One beat per line: `time`, or `time<TAB>1` for a downbeat |
| `chords/*.csv` | `time,chord`; each chord lasts until the next one |
| `sections/*.csv` | `time,name,beats_per_measure`; working labels that drive downbeats, chord insertion and segments (a blank `beats_per_measure` means the song's time signature is used) |
| `structure/*.csv` | `time,name`; song-form labels |
| `segments/*.csv` | `start,end`; spans usable as training data (see below) |
| `cache/` | Disposable MusicBrainz and download cache; safe to delete |

- Sections and structure events each run until the next one starts.
- A song belongs to the lead sheet whose `title` matches its `standard`, ignoring case.
- Chords use the shorhand Harte notation, `root:quality(extensions)/bass`, e.g. `F:min7`, `C:7(#9)`, `C:maj7/3`. The bass is written as an interval above the root, not as a note name. `N` means no chord, and in lead sheets `%` repeats the previous chord. `jsir/chords.py` provides a parser and transposition helpers.
- **Segments** are generated from the sections. They cover the runs of sections whose names do not contain `intro`, `outro`, `solo:bass` or `exclude`. A run that reaches the end of the song stops at the last downbeat.
- `tonality` is one of `functional`, `blues` or `modal`.

## Export

```bash
python export.py /path/to/JSIR                  # with audio
python export.py /path/to/JSIR --exclude-audio  # labels and metadata only
```

The script exports every song marked complete: its audio, beats, chords, structure and segments, plus the matching entries of `metadata.json` and `lead_sheets.json`. Sections are not exported. Always pass a destination, because the built-in default path is specific to the original setup. Existing files in the destination's label folders are deleted before the copy.

## Notes

- The MusicBrainz client sends the original maintainers' contact address in its User-Agent (`MB_USER_AGENT` in `app.py`). Please replace it with your own before using the MusicBrainz search.
- If YouTube downloads start failing, you may want to update yt-dlp (`pip install -U yt-dlp`) and check that Deno is installed.