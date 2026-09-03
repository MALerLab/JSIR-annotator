"""
Web-based annotation tool for beat-tracked jazz recordings.

Backend responsibilities:
  - serve the single-page UI
  - expose the dataset metadata
  - serve audio files (with HTTP range support so seeking works)
  - read / write beat files       (beats/<name>.txt   : one float per line)
  - read / write section files     (sections/<name>.csv : columns "time","name")

Run:
    pip install flask          # or: pipenv install && pipenv shell
    python app.py
    # then open http://127.0.0.1:5000
"""

import csv
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback

from flask import (
    Flask,
    abort,
    jsonify,
    request,
    send_file,
    send_from_directory,
)


ROOT = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.join(ROOT, "audio")
BEATS_DIR = os.path.join(ROOT, "beats")
SECTIONS_DIR = os.path.join(ROOT, "sections")
STRUCTURE_DIR = os.path.join(ROOT, "structure")
CHORDS_DIR = os.path.join(ROOT, "chords")
METADATA_PATH = os.path.join(ROOT, "metadata.json")
LEADSHEET_PATH = os.path.join(ROOT, "lead_sheets.json")

# Directory holding this interpreter's console scripts (DBNBeatTracker, etc.).
BIN_DIR = os.path.dirname(sys.executable)


def tool_path(name):
    """Resolve an external tool, preferring this venv's bin dir, then PATH."""
    p = os.path.join(BIN_DIR, name)
    return p if os.path.exists(p) else (shutil.which(name) or name)

app = Flask(__name__, static_folder="static", static_url_path="/static")


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def load_metadata():
    with open(METADATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def load_leadsheets_list():
    """The lead sheets file is editable from the Library tab, so it is always
    loaded fresh (never cached)."""
    if not os.path.exists(LEADSHEET_PATH):
        return []
    with open(LEADSHEET_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_leadsheets_list(data):
    # One-time pristine backup before the first in-place edit.
    backup = LEADSHEET_PATH + ".orig"
    if os.path.exists(LEADSHEET_PATH) and not os.path.exists(backup):
        shutil.copy2(LEADSHEET_PATH, backup)
    tmp = LEADSHEET_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, LEADSHEET_PATH)


def find_leadsheet_by_title(title):
    """First entry whose (lower-cased) title matches; performer is ignored."""
    title = (title or "").strip().lower()
    if not title:
        return None
    for entry in load_leadsheets_list():
        if (entry.get("title") or "").strip().lower() == title:
            return entry
    return None


def save_metadata(meta):
    # One-time pristine backup before the first in-place edit of the master file.
    backup = METADATA_PATH + ".orig"
    if not os.path.exists(backup):
        shutil.copy2(METADATA_PATH, backup)
    # Write atomically (temp file + rename) so an interrupted write can't
    # corrupt the dataset's master metadata. Match the existing 2-space,
    # ascii-escaped formatting.
    tmp = METADATA_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")
    os.replace(tmp, METADATA_PATH)


def stem_for(audio_rel_path):
    """audio/dolphin.mp3 -> dolphin"""
    return os.path.splitext(os.path.basename(audio_rel_path))[0]


def safe_stem(stem):
    """Reject anything that could escape the data directories."""
    if not stem or os.path.basename(stem) != stem:
        abort(400, "invalid name")
    return stem


def read_beats(stem):
    """Beat files are one beat per line: ``<time>`` for a normal beat or
    ``<time>\t1`` for a downbeat. The bare-float form (original madmom output)
    reads back as all-normal, so old files stay compatible."""
    path = os.path.join(BEATS_DIR, stem + ".txt")
    if not os.path.exists(path):
        return []
    beats = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = re.split(r"[,\s]+", line)
            try:
                t = float(parts[0])
            except (ValueError, IndexError):
                continue
            downbeat = len(parts) > 1 and parts[1].lower() in ("1", "true", "d", "yes")
            beats.append({"time": t, "downbeat": downbeat})
    beats.sort(key=lambda b: b["time"])
    return beats


def write_beats(stem, beats):
    path = os.path.join(BEATS_DIR, stem + ".txt")
    # Keep a one-time pristine backup of the original madmom output.
    backup = path + ".orig"
    if os.path.exists(path) and not os.path.exists(backup):
        shutil.copy2(path, backup)
    # Accept either {"time", "downbeat"} objects or bare floats (legacy).
    norm = []
    for b in beats:
        if isinstance(b, dict):
            norm.append((float(b["time"]), bool(b.get("downbeat"))))
        else:
            norm.append((float(b), False))
    norm.sort(key=lambda x: x[0])
    with open(path, "w", encoding="utf-8") as f:
        for t, downbeat in norm:
            f.write(f"{t:.3f}\t1\n" if downbeat else f"{t:.3f}\n")


def read_sections(stem):
    path = os.path.join(SECTIONS_DIR, stem + ".csv")
    if not os.path.exists(path):
        return []
    sections = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                sec = {"time": float(row["time"]), "name": row.get("name", "")}
                # optional per-section beats-per-measure override (blank = default)
                bpm = (row.get("beats_per_measure") or "").strip()
                if bpm:
                    sec["beats_per_measure"] = int(float(bpm))
                sections.append(sec)
            except (ValueError, KeyError, TypeError):
                pass
    sections.sort(key=lambda s: s["time"])
    return sections


def write_sections(stem, sections):
    os.makedirs(SECTIONS_DIR, exist_ok=True)
    path = os.path.join(SECTIONS_DIR, stem + ".csv")
    sections = sorted(sections, key=lambda s: float(s["time"]))
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["time", "name", "beats_per_measure"])
    for s in sections:
        bpm = s.get("beats_per_measure")
        writer.writerow([f"{float(s['time']):.3f}", s.get("name", ""),
                         "" if bpm in (None, "") else int(bpm)])
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(buf.getvalue())


def _read_events(path):
    if not os.path.exists(path):
        return None
    events = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            try:
                events.append({"time": float(row["time"]), "name": row.get("name", "")})
            except (ValueError, KeyError, TypeError):
                pass
    events.sort(key=lambda e: e["time"])
    return events


def read_structure(stem):
    """Structure events (same `time,name` shape as sections). Falls back to the
    section annotations when this song has no structure file yet."""
    events = _read_events(os.path.join(STRUCTURE_DIR, stem + ".csv"))
    return events if events is not None else read_sections(stem)


def write_structure(stem, structure):
    os.makedirs(STRUCTURE_DIR, exist_ok=True)
    path = os.path.join(STRUCTURE_DIR, stem + ".csv")
    structure = sorted(structure, key=lambda s: float(s["time"]))
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["time", "name"])
    for s in structure:
        writer.writerow([f"{float(s['time']):.3f}", s.get("name", "")])
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(buf.getvalue())


def read_chords(stem):
    path = os.path.join(CHORDS_DIR, stem + ".csv")
    if not os.path.exists(path):
        return []
    chords = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                chords.append(
                    {"time": float(row["time"]), "chord": row.get("chord", "")}
                )
            except (ValueError, KeyError, TypeError):
                pass
    chords.sort(key=lambda c: c["time"])
    return chords


def write_chords(stem, chords):
    os.makedirs(CHORDS_DIR, exist_ok=True)
    path = os.path.join(CHORDS_DIR, stem + ".csv")
    # Back up the original (machine-generated) chords once before first edit.
    backup = path + ".orig"
    if os.path.exists(path) and not os.path.exists(backup):
        shutil.copy2(path, backup)
    chords = sorted(chords, key=lambda c: float(c["time"]))
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["time", "chord"])
    for c in chords:
        writer.writerow([f"{float(c['time']):.3f}", c.get("chord", "")])
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(buf.getvalue())


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/songs")
def api_songs():
    meta = load_metadata()
    out = []
    for entry in meta:
        audio_rel = entry.get("files", {}).get("audio", "")
        stem = stem_for(audio_rel)
        out.append(
            {
                **{k: v for k, v in entry.items() if k != "files"},
                "stem": stem,
                "audio": audio_rel,
                "beats_file": entry.get("files", {}).get("beats", ""),
                "has_sections": os.path.exists(
                    os.path.join(SECTIONS_DIR, stem + ".csv")
                ),
                "has_chords": os.path.exists(
                    os.path.join(CHORDS_DIR, stem + ".csv")
                ),
            }
        )
    return jsonify(out)


@app.route("/api/song/<stem>")
def api_song(stem):
    stem = safe_stem(stem)
    return jsonify(
        {
            "stem": stem,
            "beats": read_beats(stem),
            "sections": read_sections(stem),
            "structure": read_structure(stem),
            "chords": read_chords(stem),
        }
    )


@app.route("/api/leadsheet")
def api_leadsheet():
    """Look up a standard's lead-sheet progression by title (case-insensitive,
    performer ignored). Used by the Edit tab's chord insertion."""
    entry = find_leadsheet_by_title(request.args.get("title"))
    if entry is None:
        return jsonify({"found": False})
    changes = entry.get("chord_changes") or []
    coda = entry.get("coda")
    return jsonify(
        {
            "found": True,
            "title": entry.get("title"),
            "key": entry.get("key"),
            "signature": entry.get("signature"),
            "chords_per_measure": entry.get("chords_per_measure"),
            "chord_changes": changes,
            "coda": coda if coda else None,
            "num_bars": len(changes),
        }
    )


# --------------------------------------------------------------------------- #
# Library: lead-sheet CRUD
# --------------------------------------------------------------------------- #
LS_EDITABLE_TEXT = {"title", "key", "signature", "tempoclass", "rhythmfeel"}


@app.route("/api/leadsheets")
def api_leadsheets_list():
    data = load_leadsheets_list()
    return jsonify([{**e, "index": i} for i, e in enumerate(data)])


@app.route("/api/leadsheets", methods=["POST"])
def api_leadsheets_create():
    payload = request.get_json(force=True) or {}
    title = (payload.get("title") or "").strip()
    if not title:
        return jsonify({"ok": False, "error": "title is required"}), 400
    data = load_leadsheets_list()
    entry = {
        "title": title,
        "signature": "4/4",
        "chords_per_measure": 4,
        "chord_changes": ["% % % %"],
    }
    data.append(entry)
    save_leadsheets_list(data)
    return jsonify({"ok": True, "index": len(data) - 1})


@app.route("/api/leadsheets/<int:idx>", methods=["POST"])
def api_leadsheets_update(idx):
    payload = request.get_json(force=True) or {}
    fields = payload.get("fields", {}) or {}
    data = load_leadsheets_list()
    if not (0 <= idx < len(data)):
        abort(404, "lead sheet not found")
    entry = data[idx]
    for key, value in fields.items():
        if key in LS_EDITABLE_TEXT:
            value = ("" if value is None else str(value)).strip()
            if value:
                entry[key] = value
            else:
                entry.pop(key, None)
        elif key == "chords_per_measure":
            try:
                entry[key] = max(1, int(value))
            except (TypeError, ValueError):
                entry.pop(key, None)
        elif key in ("chord_changes", "coda"):
            if value is None:
                entry.pop(key, None)  # used to remove an unwanted coda
            elif isinstance(value, list):
                entry[key] = [str(x) for x in value]
    save_leadsheets_list(data)
    return jsonify({"ok": True})


@app.route("/api/leadsheets/<int:idx>", methods=["DELETE"])
def api_leadsheets_delete(idx):
    data = load_leadsheets_list()
    if not (0 <= idx < len(data)):
        abort(404, "lead sheet not found")
    removed = data.pop(idx)
    save_leadsheets_list(data)
    return jsonify({"ok": True, "removed": removed.get("title")})


@app.route("/api/beats/<stem>", methods=["POST"])
def api_save_beats(stem):
    stem = safe_stem(stem)
    data = request.get_json(force=True)
    write_beats(stem, data.get("beats", []))
    return jsonify({"ok": True, "count": len(data.get("beats", []))})


@app.route("/api/sections/<stem>", methods=["POST"])
def api_save_sections(stem):
    stem = safe_stem(stem)
    data = request.get_json(force=True)
    write_sections(stem, data.get("sections", []))
    return jsonify({"ok": True, "count": len(data.get("sections", []))})


@app.route("/api/structure/<stem>", methods=["POST"])
def api_save_structure(stem):
    stem = safe_stem(stem)
    data = request.get_json(force=True)
    write_structure(stem, data.get("structure", []))
    return jsonify({"ok": True, "count": len(data.get("structure", []))})


@app.route("/api/chords/<stem>", methods=["POST"])
def api_save_chords(stem):
    stem = safe_stem(stem)
    data = request.get_json(force=True)
    write_chords(stem, data.get("chords", []))
    return jsonify({"ok": True, "count": len(data.get("chords", []))})


@app.route("/api/key/<stem>", methods=["POST"])
def api_save_key(stem):
    stem = safe_stem(stem)
    data = request.get_json(force=True)
    key = (data.get("key") or "").strip()
    meta = load_metadata()
    for entry in meta:
        if stem_for(entry.get("files", {}).get("audio", "")) == stem:
            if key:
                entry["key"] = key
            else:
                entry.pop("key", None)  # blank == None == absent
            save_metadata(meta)
            return jsonify({"ok": True, "key": key})
    abort(404, "song not found")


# Fields in the Song Info panel that the UI may edit in place.
ALLOWED_META_FIELDS = {
    "standard", "artist", "album", "instrumentation", "musicbrainz_id", "yt_id",
    "tempo_class", "rhythm_feel", "time_signature",
}
# Integer-valued editable fields (stored as ints, not strings).
ALLOWED_INT_FIELDS = {"num_bars"}
# Boolean-valued editable fields.
ALLOWED_BOOL_FIELDS = {"completed"}


@app.route("/api/meta/<stem>", methods=["POST"])
def api_save_meta(stem):
    stem = safe_stem(stem)
    data = request.get_json(force=True)
    fields = data.get("fields", {}) or {}
    meta = load_metadata()
    for entry in meta:
        if stem_for(entry.get("files", {}).get("audio", "")) == stem:
            for key, value in fields.items():
                if key in ALLOWED_BOOL_FIELDS:
                    entry[key] = bool(value)
                elif key in ALLOWED_INT_FIELDS:
                    raw = ("" if value is None else str(value)).strip()
                    try:
                        entry[key] = int(float(raw))
                    except ValueError:
                        entry.pop(key, None)  # blank/invalid -> remove
                elif key in ALLOWED_META_FIELDS:
                    raw = ("" if value is None else str(value)).strip()
                    if raw:
                        entry[key] = raw
                    else:
                        entry.pop(key, None)  # blank -> remove the field
            save_metadata(meta)
            return jsonify({"ok": True})
    abort(404, "song not found")


@app.route("/api/songs/new", methods=["POST"])
def api_songs_new():
    """Create a new song entry keyed by its YouTube ID (which becomes the audio
    filename stem). The audio/beats are crawled afterwards via /api/refresh."""
    payload = request.get_json(force=True) or {}
    yt_id = (payload.get("yt_id") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", yt_id):
        return jsonify({"ok": False, "error": "invalid YouTube ID"}), 400
    meta = load_metadata()
    if _find_entry(meta, yt_id) is not None:
        return jsonify({"ok": False, "error": f"'{yt_id}' already exists"}), 409
    entry = {
        "yt_id": yt_id,
        "completed": False,
        "files": {"audio": f"audio/{yt_id}.wav", "beats": f"beats/{yt_id}.txt"},
    }
    standard = (payload.get("standard") or "").strip()
    if standard:
        entry["standard"] = standard
    meta.append(entry)
    save_metadata(meta)
    return jsonify({"ok": True, "stem": yt_id})


@app.route("/api/song/<stem>", methods=["DELETE"])
def api_song_delete(stem):
    """Remove a song's metadata entry. Its files (audio/beats/annotations) are
    intentionally left on disk."""
    stem = safe_stem(stem)
    meta = load_metadata()
    entry = _find_entry(meta, stem)
    if entry is None:
        abort(404, "song not found")
    meta.remove(entry)
    save_metadata(meta)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Refresh audio: re-crawl a song's YouTube source, re-run beat tracking, and
# drop its (now-stale) chord/section labels. Runs in a background thread so the
# request returns immediately; the UI polls the status endpoint.
# --------------------------------------------------------------------------- #
_refresh_lock = threading.Lock()
_refresh_jobs = {}  # stem -> {"state", "step", "message", "new_stem"}


def _set_job(stem, **kw):
    with _refresh_lock:
        _refresh_jobs.setdefault(stem, {}).update(kw)


def _get_job(stem):
    with _refresh_lock:
        return dict(_refresh_jobs.get(stem, {}))


def _find_entry(meta, stem):
    for entry in meta:
        if stem_for(entry.get("files", {}).get("audio", "")) == stem:
            return entry
    return None


def _tail(*chunks, n=800):
    text = "\n".join(c for c in chunks if c).strip()
    return text[-n:] if text else "unknown error"


def _commit_refresh(old_stem, new_stem):
    """Point the entry at the new files, drop chord/section labels, and (if the
    stem changed) remove the old audio/beats."""
    meta = load_metadata()
    entry = _find_entry(meta, old_stem)
    if entry is not None:
        files = entry.setdefault("files", {})
        files["audio"] = f"audio/{new_stem}.wav"
        files["beats"] = f"beats/{new_stem}.txt"
        files["chords"] = f"chords/{new_stem}.csv"
        if "cace_chords" in files:
            files["cace_chords"] = f"consonance_ace_inferences/{new_stem}.lab"
        save_metadata(meta)

    # remove chord/section/structure labels (old and new stems) — they no longer apply
    for st in {old_stem, new_stem}:
        for path in (
            os.path.join(SECTIONS_DIR, st + ".csv"),
            os.path.join(SECTIONS_DIR, st + ".csv.orig"),
            os.path.join(STRUCTURE_DIR, st + ".csv"),
            os.path.join(CHORDS_DIR, st + ".csv"),
            os.path.join(CHORDS_DIR, st + ".csv.orig"),
        ):
            if os.path.exists(path):
                os.remove(path)

    if new_stem != old_stem:
        for path in (
            os.path.join(AUDIO_DIR, old_stem + ".wav"),
            os.path.join(BEATS_DIR, old_stem + ".txt"),
            os.path.join(BEATS_DIR, old_stem + ".txt.orig"),
        ):
            if os.path.exists(path):
                os.remove(path)


def _refresh_worker(stem, yt_id, new_stem):
    tmpdir = None
    try:
        tmpdir = tempfile.mkdtemp(prefix="refresh_")
        wav_tmp = os.path.join(tmpdir, "audio.wav")
        beats_tmp = os.path.join(tmpdir, "beats.txt")

        # 1) download + convert to WAV via yt-dlp (uses ffmpeg)
        _set_job(stem, state="running", step="download",
                 message=f"Downloading audio for {yt_id}…")
        url = f"https://www.youtube.com/watch?v={yt_id}"
        dl = subprocess.run(
            [sys.executable, "-m", "yt_dlp", "-x", "--audio-format", "wav",
             "--no-playlist", "--force-overwrites", "--extractor-args", "youtube:player_client=android",
             "-o", os.path.join(tmpdir, "audio.%(ext)s"), url],
            capture_output=True, text=True, timeout=1800,
        )
        if dl.returncode != 0 or not os.path.exists(wav_tmp):
            raise RuntimeError("yt-dlp failed: " + _tail(dl.stderr, dl.stdout))

        # 2) beat tracking via madmom's DBNBeatTracker
        _set_job(stem, step="track", message="Tracking beats (madmom)…")
        bt = subprocess.run(
            [tool_path("DBNBeatTracker"), "single", "-o", beats_tmp, wav_tmp],
            capture_output=True, text=True, timeout=3600,
        )
        if bt.returncode != 0 or not os.path.exists(beats_tmp):
            raise RuntimeError("beat tracking failed: " + _tail(bt.stderr, bt.stdout))

        # 3) commit: move files into place, update metadata, drop labels
        _set_job(stem, step="finalize", message="Finalizing…")
        os.makedirs(AUDIO_DIR, exist_ok=True)
        os.makedirs(BEATS_DIR, exist_ok=True)
        shutil.move(wav_tmp, os.path.join(AUDIO_DIR, new_stem + ".wav"))
        shutil.move(beats_tmp, os.path.join(BEATS_DIR, new_stem + ".txt"))
        orig = os.path.join(BEATS_DIR, new_stem + ".txt.orig")
        if os.path.exists(orig):
            os.remove(orig)  # stale backup of the previous beats
        _commit_refresh(stem, new_stem)

        _set_job(stem, state="done", step="done", message="Done", new_stem=new_stem)
    except subprocess.TimeoutExpired:
        _set_job(stem, state="error", step="error", message="timed out")
    except Exception as exc:  # noqa: BLE001 — surface any step failure to the UI
        traceback.print_exc()
        _set_job(stem, state="error", step="error", message=str(exc))
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


@app.route("/api/refresh/<stem>", methods=["POST"])
def api_refresh(stem):
    stem = safe_stem(stem)
    meta = load_metadata()
    entry = _find_entry(meta, stem)
    if entry is None:
        abort(404, "song not found")
    yt_id = (entry.get("yt_id") or "").strip()
    if not yt_id:
        return jsonify({"ok": False, "error": "no YouTube ID set for this song"}), 400
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", yt_id):
        return jsonify({"ok": False, "error": "YouTube ID is not a valid filename"}), 400
    new_stem = yt_id
    # guard against clobbering a different entry's files
    if new_stem != stem:
        other = _find_entry(meta, new_stem)
        if other is not None and other is not entry:
            return jsonify({"ok": False,
                            "error": f"'{new_stem}' is already used by another song"}), 409
    if _get_job(stem).get("state") == "running":
        return jsonify({"ok": True, "already": True, "new_stem": new_stem})
    _set_job(stem, state="running", step="start", message="Starting…", new_stem=new_stem)
    threading.Thread(target=_refresh_worker, args=(stem, yt_id, new_stem),
                     daemon=True).start()
    return jsonify({"ok": True, "new_stem": new_stem})


@app.route("/api/refresh/<stem>/status")
def api_refresh_status(stem):
    stem = safe_stem(stem)
    return jsonify(_get_job(stem) or {"state": "idle"})


@app.route("/audio/<path:filename>")
def serve_audio(filename):
    path = os.path.join(AUDIO_DIR, filename)
    if not os.path.isfile(path):
        abort(404)
    # conditional=True enables HTTP range requests -> smooth seeking.
    return send_file(path, conditional=True)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True, threaded=True)
