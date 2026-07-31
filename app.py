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
CHORDS_DIR = os.path.join(ROOT, "chords")
METADATA_PATH = os.path.join(ROOT, "metadata.json")

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
                sections.append(
                    {"time": float(row["time"]), "name": row.get("name", "")}
                )
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
    writer.writerow(["time", "name"])
    for s in sections:
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
            "chords": read_chords(stem),
        }
    )


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
}
# Integer-valued editable fields (stored as ints, not strings).
ALLOWED_INT_FIELDS = {"num_bars"}


@app.route("/api/meta/<stem>", methods=["POST"])
def api_save_meta(stem):
    stem = safe_stem(stem)
    data = request.get_json(force=True)
    fields = data.get("fields", {}) or {}
    meta = load_metadata()
    for entry in meta:
        if stem_for(entry.get("files", {}).get("audio", "")) == stem:
            for key, value in fields.items():
                if key in ALLOWED_INT_FIELDS:
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

    # remove chord & section labels (old and new stems) — they no longer apply
    for st in {old_stem, new_stem}:
        for path in (
            os.path.join(SECTIONS_DIR, st + ".csv"),
            os.path.join(SECTIONS_DIR, st + ".csv.orig"),
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
             "--no-playlist", "--force-overwrites",
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
