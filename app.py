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
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave

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
# Temporary data for the Library's collection steps. Everything in here is
# disposable: MusicBrainz recording lists are cached per linked work (dropped
# when the work is unlinked), crawl downloads are staged per job (dropped when
# the job ends), and a sweep at start-up removes anything left behind.
CACHE_DIR = os.path.join(ROOT, "cache")
MB_CACHE_DIR = os.path.join(CACHE_DIR, "mb")
CRAWL_CACHE_DIR = os.path.join(CACHE_DIR, "crawl")

# MusicBrainz asks for a real contact in the User-Agent (same string the
# original js-dataset-crawler used) and <= 1 request/second per client.
MB_USER_AGENT = "js-dataset-annotator/0.1 (sogang.maler@gmail.com)"
MB_MIN_INTERVAL = 1.1
MB_BATCH = 50          # recording ids per search query (URL-length bound)
YT_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")

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
    """audio/dolphin.mp3 -> dolphin ('' when the song has no audio yet)"""
    return os.path.splitext(os.path.basename(audio_rel_path or ""))[0]


def entry_stem(entry):
    return stem_for(entry.get("files", {}).get("audio", ""))


def ensure_song_ids(meta):
    """Every song carries a stable uuid4 `id` (songs added by curation have no
    yt_id / audio yet, so the file stem can't serve as identity). Returns True
    if any entry had to be assigned one."""
    changed = False
    for entry in meta:
        if not entry.get("id"):
            entry["id"] = str(uuid.uuid4())
            changed = True
    return changed


def _find_entry(meta, key):
    """Look a song up by its `id`, falling back to the audio file stem so the
    older stem-keyed URLs keep working."""
    if not key:
        return None
    for entry in meta:
        if entry.get("id") == key:
            return entry
    for entry in meta:
        if entry_stem(entry) == key:
            return entry
    return None


def wav_duration(path):
    """Length of a PCM WAV in seconds (None if unreadable)."""
    try:
        with wave.open(path, "rb") as w:
            rate = w.getframerate()
            return w.getnframes() / float(rate) if rate else None
    except Exception:  # noqa: BLE001 — duration is best-effort metadata
        return None


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
    if ensure_song_ids(meta):  # safety net: ids are normally assigned on creation
        save_metadata(meta)
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
                "has_audio": bool(stem) and os.path.isfile(os.path.join(AUDIO_DIR, stem + ".wav")),
                "has_sections": bool(stem) and os.path.exists(
                    os.path.join(SECTIONS_DIR, stem + ".csv")
                ),
                "has_chords": bool(stem) and os.path.exists(
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
LS_EDITABLE_TEXT = {"title", "key", "signature", "tempoclass", "rhythmfeel",
                    "musicbrainz_id", "composer"}


def sweep_mb_cache(leadsheets=None):
    """Keep cached MusicBrainz recording lists only for works that some lead
    sheet currently links; everything else (works merely browsed in step 1,
    unlinked works, deleted lead sheets) is removed."""
    if not os.path.isdir(MB_CACHE_DIR):
        return
    if leadsheets is None:
        leadsheets = load_leadsheets_list()
    linked = {e.get("musicbrainz_id") for e in leadsheets if e.get("musicbrainz_id")}
    for name in os.listdir(MB_CACHE_DIR):
        work_id = name[:-5] if name.endswith(".json") else None
        if work_id not in linked:
            try:
                os.remove(os.path.join(MB_CACHE_DIR, name))
            except OSError:
                pass


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
    old_work = entry.get("musicbrainz_id")
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
    if "musicbrainz_id" in fields and entry.get("musicbrainz_id") != old_work:
        sweep_mb_cache(data)   # linked / unlinked: drop caches of works nobody links
        if entry.get("musicbrainz_id"):
            _persist_mb_result(entry["musicbrainz_id"])   # already fetched in step 1?
    return jsonify({"ok": True})


@app.route("/api/leadsheets/<int:idx>", methods=["DELETE"])
def api_leadsheets_delete(idx):
    data = load_leadsheets_list()
    if not (0 <= idx < len(data)):
        abort(404, "lead sheet not found")
    removed = data.pop(idx)
    save_leadsheets_list(data)
    sweep_mb_cache(data)
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


@app.route("/api/key/<song>", methods=["POST"])
def api_save_key(song):
    data = request.get_json(force=True)
    key = (data.get("key") or "").strip()
    meta = load_metadata()
    entry = _find_entry(meta, safe_stem(song))
    if entry is None:
        abort(404, "song not found")
    if key:
        entry["key"] = key
    else:
        entry.pop("key", None)  # blank == None == absent
    save_metadata(meta)
    return jsonify({"ok": True, "key": key})


# Fields in the Song Info panel that the UI may edit in place.
ALLOWED_META_FIELDS = {
    "standard", "artist", "album", "instrumentation", "musicbrainz_id", "yt_id",
    "tempo_class", "rhythm_feel", "time_signature",
}
# Integer-valued editable fields (stored as ints, not strings).
ALLOWED_INT_FIELDS = {"num_bars"}
# Boolean-valued editable fields.
ALLOWED_BOOL_FIELDS = {"completed"}


def _apply_meta_fields(entry, fields):
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


@app.route("/api/meta/<song>", methods=["POST"])
def api_save_meta(song):
    data = request.get_json(force=True)
    fields = data.get("fields", {}) or {}
    meta = load_metadata()
    entry = _find_entry(meta, safe_stem(song))
    if entry is None:
        abort(404, "song not found")
    yt_id = fields.get("yt_id")
    if yt_id is not None and str(yt_id).strip():
        yt_id = str(yt_id).strip()
        if not YT_ID_RE.fullmatch(yt_id):
            return jsonify({"ok": False, "error": "invalid YouTube ID"}), 400
        other = next((e for e in meta if e is not entry and e.get("yt_id") == yt_id), None)
        if other is not None:
            return jsonify({"ok": False, "error": "that YouTube ID is already used by "
                            f"another song ({other.get('artist') or '?'} – {other.get('standard') or '?'})"}), 409
    _apply_meta_fields(entry, fields)
    save_metadata(meta)
    return jsonify({"ok": True})


@app.route("/api/songs/new", methods=["POST"])
def api_songs_new():
    """Create a song entry. Songs are identified by a fresh uuid4 `id`; the
    YouTube ID is optional at this point (the Curation step adds songs straight
    from MusicBrainz) and the audio/beats files only appear once the song is
    crawled (/api/refresh). Duplicate guards: yt_id, and the MusicBrainz
    recording id unless `force` is set."""
    payload = request.get_json(force=True) or {}
    fields = {k: payload.get(k) for k in
              (ALLOWED_META_FIELDS | ALLOWED_INT_FIELDS | {"key"}) if k in payload}
    yt_id = (str(fields.get("yt_id") or "")).strip()
    if yt_id and not YT_ID_RE.fullmatch(yt_id):
        return jsonify({"ok": False, "error": "invalid YouTube ID"}), 400
    meta = load_metadata()
    ensure_song_ids(meta)
    if yt_id and any(e.get("yt_id") == yt_id or entry_stem(e) == yt_id for e in meta):
        return jsonify({"ok": False, "error": f"a song with YouTube ID '{yt_id}' already exists"}), 409
    mbid = (str(fields.get("musicbrainz_id") or "")).strip()
    if mbid and not payload.get("force"):
        dup = next((e for e in meta if e.get("musicbrainz_id") == mbid), None)
        if dup is not None:
            return jsonify({"ok": False, "duplicate": True, "existing_id": dup.get("id"),
                            "error": "this recording is already in the dataset"}), 409
    entry = {"id": str(uuid.uuid4()), "completed": False}
    key = (str(fields.pop("key", "") or "")).strip()
    if key:
        entry["key"] = key
    _apply_meta_fields(entry, fields)
    meta.append(entry)
    save_metadata(meta)
    return jsonify({"ok": True, "id": entry["id"], "stem": yt_id})


@app.route("/api/song/<song>", methods=["DELETE"])
def api_song_delete(song):
    """Remove a song's metadata entry. Its files (audio/beats/annotations) are
    intentionally left on disk."""
    meta = load_metadata()
    entry = _find_entry(meta, safe_stem(song))
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
_refresh_jobs = {}  # job key (song id / "mb:<work>") -> {"state", "step", "message", ...}


def _set_job(key, **kw):
    with _refresh_lock:
        _refresh_jobs.setdefault(key, {}).update(kw)


def _get_job(key):
    with _refresh_lock:
        return dict(_refresh_jobs.get(key, {}))


def _tail(*chunks, n=800):
    text = "\n".join(c for c in chunks if c).strip()
    return text[-n:] if text else "unknown error"


def _commit_refresh(song_id, old_stem, new_stem):
    """Point the entry at the new files (recording the new audio length), drop
    chord/section labels, and (if the stem changed) remove the old audio/beats."""
    meta = load_metadata()
    entry = _find_entry(meta, song_id)
    if entry is not None:
        files = entry.setdefault("files", {})
        files["audio"] = f"audio/{new_stem}.wav"
        files["beats"] = f"beats/{new_stem}.txt"
        files["chords"] = f"chords/{new_stem}.csv"
        if "cace_chords" in files:
            files["cace_chords"] = f"consonance_ace_inferences/{new_stem}.lab"
        dur = wav_duration(os.path.join(AUDIO_DIR, new_stem + ".wav"))
        if dur is not None:
            entry["audio_length"] = dur
        save_metadata(meta)

    # remove chord/section/structure labels (old and new stems) — they no longer apply
    for st in {st for st in (old_stem, new_stem) if st}:
        for path in (
            os.path.join(SECTIONS_DIR, st + ".csv"),
            os.path.join(SECTIONS_DIR, st + ".csv.orig"),
            os.path.join(STRUCTURE_DIR, st + ".csv"),
            os.path.join(CHORDS_DIR, st + ".csv"),
            os.path.join(CHORDS_DIR, st + ".csv.orig"),
        ):
            if os.path.exists(path):
                os.remove(path)

    if old_stem and new_stem != old_stem:
        for path in (
            os.path.join(AUDIO_DIR, old_stem + ".wav"),
            os.path.join(BEATS_DIR, old_stem + ".txt"),
            os.path.join(BEATS_DIR, old_stem + ".txt.orig"),
        ):
            if os.path.exists(path):
                os.remove(path)


def _refresh_worker(song_id, old_stem, yt_id, new_stem):
    tmpdir = None
    try:
        os.makedirs(CRAWL_CACHE_DIR, exist_ok=True)
        tmpdir = tempfile.mkdtemp(prefix=f"{new_stem}_", dir=CRAWL_CACHE_DIR)
        wav_tmp = os.path.join(tmpdir, "audio.wav")
        beats_tmp = os.path.join(tmpdir, "beats.txt")

        # 1) download + convert to WAV via yt-dlp (uses ffmpeg)
        _set_job(song_id, state="running", step="download",
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
        _set_job(song_id, step="track", message="Tracking beats (madmom)…")
        bt = subprocess.run(
            [tool_path("DBNBeatTracker"), "single", "-o", beats_tmp, wav_tmp],
            capture_output=True, text=True, timeout=3600,
        )
        if bt.returncode != 0 or not os.path.exists(beats_tmp):
            raise RuntimeError("beat tracking failed: " + _tail(bt.stderr, bt.stdout))

        # 3) commit: move files into place, update metadata, drop labels
        _set_job(song_id, step="finalize", message="Finalizing…")
        os.makedirs(AUDIO_DIR, exist_ok=True)
        os.makedirs(BEATS_DIR, exist_ok=True)
        shutil.move(wav_tmp, os.path.join(AUDIO_DIR, new_stem + ".wav"))
        shutil.move(beats_tmp, os.path.join(BEATS_DIR, new_stem + ".txt"))
        orig = os.path.join(BEATS_DIR, new_stem + ".txt.orig")
        if os.path.exists(orig):
            os.remove(orig)  # stale backup of the previous beats
        _commit_refresh(song_id, old_stem, new_stem)

        _set_job(song_id, state="done", step="done", message="Done", new_stem=new_stem)
    except subprocess.TimeoutExpired:
        _set_job(song_id, state="error", step="error", message="timed out")
    except Exception as exc:  # noqa: BLE001 — surface any step failure to the UI
        traceback.print_exc()
        _set_job(song_id, state="error", step="error", message=str(exc))
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


@app.route("/api/refresh/<song>", methods=["POST"])
@app.route("/api/crawl/<song>", methods=["POST"])
def api_refresh(song):
    """Crawl (or re-crawl) a song's audio from its YouTube ID. `song` is the
    song id (or, for older callers, its audio stem)."""
    meta = load_metadata()
    entry = _find_entry(meta, safe_stem(song))
    if entry is None:
        abort(404, "song not found")
    song_id = entry.get("id") or entry_stem(entry)
    old_stem = entry_stem(entry) or None
    yt_id = (entry.get("yt_id") or "").strip()
    if not yt_id:
        return jsonify({"ok": False, "error": "no YouTube ID set for this song"}), 400
    if not YT_ID_RE.fullmatch(yt_id):
        return jsonify({"ok": False, "error": "YouTube ID is not a valid filename"}), 400
    new_stem = yt_id
    # guard against clobbering a different entry's files
    other = next((e for e in meta if e is not entry and entry_stem(e) == new_stem), None)
    if other is not None:
        return jsonify({"ok": False,
                        "error": f"'{new_stem}' is already used by another song"}), 409
    if _get_job(song_id).get("state") == "running":
        return jsonify({"ok": True, "already": True, "id": song_id, "new_stem": new_stem})
    _set_job(song_id, state="running", step="start", message="Starting…", new_stem=new_stem)
    threading.Thread(target=_refresh_worker, args=(song_id, old_stem, yt_id, new_stem),
                     daemon=True).start()
    return jsonify({"ok": True, "id": song_id, "new_stem": new_stem})


@app.route("/api/refresh/<song>/status")
@app.route("/api/crawl/<song>/status")
def api_refresh_status(song):
    song = safe_stem(song)
    job = _get_job(song)
    if not job:  # older callers poll by stem — map it to the song id
        entry = _find_entry(load_metadata(), song)
        if entry is not None and entry.get("id"):
            job = _get_job(entry["id"])
    return jsonify(job or {"state": "idle"})


# --------------------------------------------------------------------------- #
# Library collection steps: MusicBrainz work search / recordings, YouTube search
# --------------------------------------------------------------------------- #
_mb_lock = threading.Lock()
_mb_last = [0.0]


def mb_get(path, params, tries=4):
    """Rate-limited GET against the MusicBrainz WS/2 JSON API.

    MusicBrainz allows ~1 request/second per client and answers 503 ("server
    busy") when it is overloaded, so calls are serialised through a lock and
    retried with a growing pause."""
    params = {**params, "fmt": "json"}
    url = f"https://musicbrainz.org/ws/2/{path}?" + urllib.parse.urlencode(params)
    delay = 2.0
    for attempt in range(tries):
        with _mb_lock:
            wait = MB_MIN_INTERVAL - (time.monotonic() - _mb_last[0])
            if wait > 0:
                time.sleep(wait)
            req = urllib.request.Request(url, headers={"User-Agent": MB_USER_AGENT})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    _mb_last[0] = time.monotonic()
                    data = json.load(r)
            except urllib.error.HTTPError as e:
                _mb_last[0] = time.monotonic()
                if e.code in (503, 429) and attempt < tries - 1:
                    data = None
                else:
                    raise RuntimeError(f"MusicBrainz HTTP {e.code}") from e
            except (urllib.error.URLError, TimeoutError) as e:
                raise RuntimeError(f"MusicBrainz unreachable: {e}") from e
        if data is not None and "error" not in data:
            return data
        if data is not None and attempt == tries - 1:
            raise RuntimeError("MusicBrainz: " + str(data.get("error")))
        time.sleep(delay)
        delay *= 2
    raise RuntimeError("MusicBrainz is busy — please try again in a moment")


_WRITER_RELS = {"composer", "writer"}


def _work_summary(w):
    """Compact view of a work from a search result / lookup (with relations)."""
    composers, lyricists, rec_ids = [], [], []
    for rel in w.get("relations", []) or []:
        t = rel.get("type")
        if t in _WRITER_RELS and rel.get("artist"):
            name = rel["artist"].get("name")
            if name and name not in composers:
                composers.append(name)
        elif t == "lyricist" and rel.get("artist"):
            name = rel["artist"].get("name")
            if name and name not in lyricists:
                lyricists.append(name)
        elif t == "performance" and rel.get("recording"):
            rid = rel["recording"]["id"]
            if rid not in rec_ids:  # the same recording may be linked twice
                rec_ids.append(rid)
    return {
        "id": w.get("id"),
        "title": w.get("title"),
        "type": w.get("type"),
        "disambiguation": w.get("disambiguation") or "",
        "language": w.get("language"),
        "composers": composers,
        "lyricists": lyricists,
        "recording_ids": rec_ids,
        "recording_count": len(rec_ids),
        "score": w.get("score"),
    }


@app.route("/api/mb/works")
def api_mb_works():
    """Search MusicBrainz works. Plain text is matched against the work title;
    anything that already looks like Lucene syntax (field:, quotes) is sent as
    is. Results are sorted by their number of linked recordings."""
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"ok": False, "error": "empty query"}), 400
    offset = max(0, int(request.args.get("offset", 0) or 0))
    limit = min(100, max(1, int(request.args.get("limit", 50) or 50)))
    lucene = q if (":" in q or '"' in q) else 'work:"%s"' % q.replace('"', "")
    try:
        res = mb_get("work", {"query": lucene, "limit": limit, "offset": offset})
    except RuntimeError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502
    works = [_work_summary(w) for w in res.get("works", [])]
    works.sort(key=lambda w: (-w["recording_count"], -(w["score"] or 0)))
    return jsonify({"ok": True, "query": lucene, "count": res.get("count", len(works)),
                    "offset": res.get("offset", offset), "limit": limit, "works": works})


def _mb_cache_path(work_id):
    return os.path.join(MB_CACHE_DIR, f"{work_id}.json")


# Recording lists fetched this session. They are only written to cache/mb for
# works a lead sheet links (step 1 browsing of other works stays in memory), so
# nothing lingers on disk for works that were merely looked at.
_mb_results = {}


def _work_is_linked(work_id, leadsheets=None):
    if leadsheets is None:
        leadsheets = load_leadsheets_list()
    return any(e.get("musicbrainz_id") == work_id for e in leadsheets)


def _persist_mb_result(work_id):
    data = _mb_results.get(work_id)
    if data is None:
        return
    os.makedirs(MB_CACHE_DIR, exist_ok=True)
    tmp = _mb_cache_path(work_id) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, _mb_cache_path(work_id))


def _earliest_release(releases):
    """(title, date) of the earliest dated release, else the first release."""
    dated = [r for r in releases if r.get("date")]
    if dated:
        r = min(dated, key=lambda r: r["date"])
        return r.get("title"), r.get("date")
    if releases:
        return releases[0].get("title"), None
    return None, None


def _mb_recordings_worker(work_id):
    """Fetch every recording of a work with artist / date / length / release
    count (batched `rid:` searches carry the release lists), then cache it."""
    key = f"mb:{work_id}"
    try:
        _set_job(key, state="running", message="Looking up the work…")
        w = mb_get(f"work/{work_id}", {"inc": "recording-rels+artist-rels"})
        summary = _work_summary(w)
        ids = summary.pop("recording_ids")
        found = {}
        for i in range(0, len(ids), MB_BATCH):
            chunk = ids[i:i + MB_BATCH]
            _set_job(key, message=f"Fetching recordings {min(i + MB_BATCH, len(ids))} / {len(ids)}…")
            res = mb_get("recording", {"query": " OR ".join("rid:" + r for r in chunk),
                                       "limit": 100})
            for rec in res.get("recordings", []):
                releases = rec.get("releases", []) or []
                album, album_date = _earliest_release(releases)
                found[rec["id"]] = {
                    "id": rec["id"],
                    "title": rec.get("title"),
                    "artist": "".join(
                        (a.get("name") or "") + (a.get("joinphrase") or "")
                        for a in rec.get("artist-credit", []) or []) or "Unknown",
                    "date": rec.get("first-release-date") or album_date or "",
                    "length_ms": rec.get("length"),
                    "releases": len(releases),
                    "album": album or "",
                }
        # recordings the search index hasn't caught up with: keep a bare row
        titles = {rel["recording"]["id"]: rel["recording"].get("title")
                  for rel in w.get("relations", []) or [] if rel.get("recording")}
        recordings = [found.get(r) or {"id": r, "title": titles.get(r), "artist": "Unknown",
                                       "date": "", "length_ms": None, "releases": 0, "album": ""}
                      for r in ids]
        recordings.sort(key=lambda r: (-r["releases"], r["date"] or "9999"))
        data = {"work": summary, "fetched_at": time.time(), "recordings": recordings}
        _mb_results[work_id] = data
        if _work_is_linked(work_id):
            _persist_mb_result(work_id)
        _set_job(key, state="done", message="Done")
    except Exception as exc:  # noqa: BLE001 — surface to the UI
        traceback.print_exc()
        _set_job(key, state="error", message=str(exc))


@app.route("/api/mb/work/<work_id>/recordings")
def api_mb_work_recordings(work_id):
    """Recordings of a work, from cache/mb when available. Otherwise a background
    fetch is started and {"state": "running"} is returned for the UI to poll.
    ?refresh=1 forces a refetch."""
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", work_id):
        return jsonify({"ok": False, "error": "invalid work id"}), 400
    key = f"mb:{work_id}"
    job = _get_job(key)
    path = _mb_cache_path(work_id)
    refresh = request.args.get("refresh") in ("1", "true")
    if not refresh and job.get("state") != "running":
        data = _mb_results.get(work_id)
        if data is None and os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            _mb_results[work_id] = data
        if data is not None:
            return jsonify({"ok": True, "state": "done", "cached": True, **data})
    if job.get("state") == "running":
        return jsonify({"ok": True, "state": "running", "message": job.get("message", "")})
    if job.get("state") == "error" and not refresh and not request.args.get("start"):
        # report the failure once, then allow a retry on the next call
        _set_job(key, state="idle")
        return jsonify({"ok": False, "state": "error", "error": job.get("message")}), 502
    _set_job(key, state="running", message="Starting…")
    threading.Thread(target=_mb_recordings_worker, args=(work_id,), daemon=True).start()
    return jsonify({"ok": True, "state": "running", "message": "Starting…"})


@app.route("/api/yt/search")
def api_yt_search():
    """YouTube search via yt-dlp (no API key). Returns id/title/channel/duration
    for the top N hits; metadata only, nothing is downloaded."""
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"ok": False, "error": "empty query"}), 400
    n = min(25, max(1, int(request.args.get("n", 10) or 10)))
    try:
        out = subprocess.run(
            [sys.executable, "-m", "yt_dlp", f"ytsearch{n}:{q}", "--flat-playlist",
             "--skip-download", "--no-warnings", "--dump-single-json"],
            capture_output=True, text=True, timeout=90,
        )
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "yt-dlp search timed out"}), 504
    if out.returncode != 0 or not out.stdout.strip():
        return jsonify({"ok": False, "error": "yt-dlp failed: " + _tail(out.stderr, out.stdout, n=300)}), 502
    try:
        data = json.loads(out.stdout)
    except ValueError:
        return jsonify({"ok": False, "error": "yt-dlp returned unreadable output"}), 502
    results = []
    for e in data.get("entries", []) or []:
        vid = e.get("id")
        if not vid or not YT_ID_RE.fullmatch(vid):
            continue
        results.append({
            "id": vid,
            "title": e.get("title") or "",
            "channel": e.get("channel") or e.get("uploader") or "",
            "duration": e.get("duration"),
            "view_count": e.get("view_count"),
            "thumbnail": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
        })
    return jsonify({"ok": True, "query": q, "results": results})


def sweep_cache():
    """Start-up housekeeping for cache/: crawl staging dirs are always stale by
    now, and MusicBrainz recording lists are only kept for works some lead
    sheet still links."""
    if os.path.isdir(CRAWL_CACHE_DIR):
        for name in os.listdir(CRAWL_CACHE_DIR):
            shutil.rmtree(os.path.join(CRAWL_CACHE_DIR, name), ignore_errors=True)
    sweep_mb_cache()


sweep_cache()


@app.route("/audio/<path:filename>")
def serve_audio(filename):
    path = os.path.join(AUDIO_DIR, filename)
    if not os.path.isfile(path):
        abort(404)
    # conditional=True enables HTTP range requests -> smooth seeking.
    return send_file(path, conditional=True)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True, threaded=True)
