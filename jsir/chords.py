"""Harte chord notation: parsing, key handling and transposition.

Every chord in the dataset -- lead-sheet changes, hand-labelled chord events and
the Consonance ACE inferences -- is written in Harte notation:

    {root}:{shorthand}({extensions})/{bass}

with `N` for no chord and `%` (lead sheets only) for "hold the previous chord".
Both the shorthand and the parenthesised part may be omitted, the parenthesised
part may also stand alone as an explicit interval list (`G:(1,5)`), and the bass
is an *interval* relative to the root (`C:maj/3`, `G:7/b7`), not a note name.
"""

from collections import namedtuple
from typing import Optional, Union
import re


NOTE_LETTERS = "CDEFGAB"
LETTER_PC = [0, 2, 4, 5, 7, 9, 11]      # pitch class of each natural letter

# Scale degree -> semitones above the root, before accidentals ("b7" -> 11-1).
DEGREE_PC = {1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11,
             8: 12, 9: 14, 10: 16, 11: 17, 12: 19, 13: 21}

NOTE_RE = re.compile(r"^([A-G])([#b]*)")
DEGREE_RE = re.compile(r"^\*?([#b]*)(\d{1,2})$")

# Harte shorthand -> intervals (semitones above the root).
harte_qualities = {
  "maj": [0, 4, 7],
  "min": [0, 3, 7],
  "dim": [0, 3, 6],
  "aug": [0, 4, 8],
  "maj7": [0, 4, 7, 11],
  "min7": [0, 3, 7, 10],
  "7": [0, 4, 7, 10],
  "dim7": [0, 3, 6, 9],
  "hdim7": [0, 3, 6, 10],
  "minmaj7": [0, 3, 7, 11],
  "maj6": [0, 4, 7, 9],
  "min6": [0, 3, 7, 9],
  "9": [0, 4, 7, 10, 14],
  "maj9": [0, 4, 7, 11, 14],
  "min9": [0, 3, 7, 10, 14],
  "11": [0, 4, 7, 10, 14, 17],
  "maj11": [0, 4, 7, 11, 14, 17],
  "min11": [0, 3, 7, 10, 14, 17],
  "13": [0, 4, 7, 10, 14, 17, 21],
  "maj13": [0, 4, 7, 11, 14, 17, 21],
  "min13": [0, 3, 7, 10, 14, 17, 21],
  "sus2": [0, 2, 7],
  "sus4": [0, 5, 7],
}

NO_CHORD = {"N", ""}
HOLD = "%"

# Position of each major tonic on the circle of fifths; used to decide whether a
# key is spelled with sharps or with flats.
FIFTHS = {"Cb": -7, "Gb": -6, "Db": -5, "Ab": -4, "Eb": -3, "Bb": -2, "F": -1,
          "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F#": 6, "C#": 7,
          "G#": 8, "D#": 9, "A#": 10}

SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

# How to move chords from one key to another: `letters` note letters up and
# `semitones` semitones up, spelling anything that falls outside the simple
# letter+accidental scheme with sharps or flats per `prefer_sharps`.
Shift = namedtuple("Shift", "letters semitones prefer_sharps")


# --------------------------------------------------------------------------- #
# Notes and degrees
# --------------------------------------------------------------------------- #
def parse_note(s: str) -> Optional[tuple[int, int, int]]:
  """Leading note name of `s` -> (letter index 0-6, accidentals, chars consumed).
  Accidentals are counted as +1 per '#' and -1 per 'b'. None if `s` doesn't
  start with a note name."""
  m = NOTE_RE.match(s or "")
  if m is None:
    return None
  acc = m.group(2).count("#") - m.group(2).count("b")
  return NOTE_LETTERS.index(m.group(1)), acc, m.end()


def note_pc(name: str) -> Optional[int]:
  """Pitch class (0-11) of a note name, or None if it isn't one."""
  parsed = parse_note(name)
  if parsed is None or parsed[2] != len(name):
    return None
  letter, acc, _ = parsed
  return (LETTER_PC[letter] + acc) % 12


def spell_note(letter: int, pc: int, prefer_sharps: bool = False) -> str:
  """Spell pitch class `pc` using note letter `letter` (0-6), e.g. letter B with
  pc 10 -> 'Bb'. Distant key pairs can push a letter more than one accidental
  away from its pitch (Ab's B:maj7 is G##:maj7 in F#); nobody wants to read that
  in a chord chart, so those fall back to a plain sharp/flat spelling of the
  same pitch (A:maj7)."""
  acc = ((pc - LETTER_PC[letter % 7] + 6) % 12) - 6
  if abs(acc) > 1:
    return (SHARP_NAMES if prefer_sharps else FLAT_NAMES)[pc % 12]
  return NOTE_LETTERS[letter % 7] + ("#" * acc if acc > 0 else "b" * -acc)


def degree_pc(degree: str) -> Optional[int]:
  """Scale degree -> semitones above the root, e.g. 'b7' -> 10, '#11' -> 6.
  Leading '*' (Harte's "omit this note") is accepted and ignored."""
  m = DEGREE_RE.match((degree or "").strip())
  if m is None:
    return None
  acc = m.group(1).count("#") - m.group(1).count("b")
  base = DEGREE_PC.get(int(m.group(2)))
  return None if base is None else (base + acc) % 12


# --------------------------------------------------------------------------- #
# Chords
# --------------------------------------------------------------------------- #
def split_harte_chord(chord_str: str):
  """Split a chord into its written parts: (root, shorthand, extensions, bass),
  where `root` is a note name, `shorthand`/`bass` are strings or None and
  `extensions` is a list of degree strings (empty when none were written).
  Returns None for no-chord/hold/unparseable input."""
  s = (chord_str or "").strip()
  if s in NO_CHORD or s == HOLD:
    return None

  main, slash, bass = s.partition("/")
  bass = bass.strip() if slash else None

  parsed = parse_note(main)
  if parsed is None:
    return None
  root = main[:parsed[2]]
  rest = main[parsed[2]:]
  if rest.startswith(":"):
    rest = rest[1:]
  elif rest:
    return None                     # e.g. "Cmaj7" -- not Harte

  shorthand, extensions = rest, []
  if "(" in rest:
    shorthand, _, ext = rest.partition("(")
    extensions = [e.strip() for e in ext.rstrip(")").split(",") if e.strip()]
  return root, (shorthand or None), extensions, bass


def parse_harte_chord(chord_str: str) -> tuple[
    Union[int, None], Union[list[int], None], Union[int, None], Union[list[int], None]]:
  """Chord -> (root pitch class, quality intervals, bass interval, extension
  intervals), all in semitones and all None for `N`/`%`/unparseable input.
  `G:(1,5)` (a bare interval list) comes back as its own quality."""
  parts = split_harte_chord(chord_str)
  if parts is None:
    return None, None, None, None
  root_str, shorthand, ext_strs, bass_str = parts

  root = note_pc(root_str)
  if root is None:
    return None, None, None, None

  extensions = [pc for pc in (degree_pc(e) for e in ext_strs) if pc is not None]
  if shorthand is None:
    # "C" or "C:(1,5)": no shorthand -> major triad, or the written intervals
    quality = extensions if ext_strs else list(harte_qualities["maj"])
    extensions = None
  else:
    quality = harte_qualities.get(shorthand)
    if quality is None:
      raise ValueError(f"Invalid chord quality: {shorthand} in chord {chord_str}")
    quality = list(quality)
    extensions = extensions or None

  bass = degree_pc(bass_str) if bass_str else None
  return root, quality, bass, extensions


# --------------------------------------------------------------------------- #
# Keys and transposition
# --------------------------------------------------------------------------- #
def parse_key(key_str) -> tuple[Optional[str], Optional[str]]:
  """Key label -> (root note name, mode). Accepts the lead-sheet form
  ('Ab-maj', 'C-min') and the song form ('D maj', 'F minor')."""
  if not key_str:
    return None, None
  s = str(key_str).strip()
  root_part, _, mode_part = (s.partition("-") if "-" in s else s.partition(" "))
  root = root_part.strip()
  if note_pc(root) is None:
    return None, None
  return root, ("min" if mode_part.strip().lower().startswith("min") else "maj")


def key_prefers_sharps(key_str) -> bool:
  """Is this key written with sharps? (F# major and E minor yes, Eb major no.)"""
  root, mode = parse_key(key_str)
  if root is None:
    return False
  fifths = FIFTHS.get(root, 0) - (3 if mode == "min" else 0)
  return fifths > 0


def transpose_shift(from_key, to_key) -> Optional[Shift]:
  """How to move chords written in `from_key` so they sound in `to_key`.
  Shifting the note letter as well as the pitch keeps the spelling musical:
  Ab -> Db moves F:min7 three letters and five semitones, to Bb:min7 rather
  than the enharmonic A#:min7. None if either key is unknown."""
  a, _ = parse_key(from_key)
  b, _ = parse_key(to_key)
  if a is None or b is None:
    return None
  la, lb = parse_note(a)[0], parse_note(b)[0]
  return Shift((lb - la) % 7, (note_pc(b) - note_pc(a)) % 12,
               key_prefers_sharps(to_key))


def shift_by_semitones(semitones: int, prefer_sharps: bool = False) -> Shift:
  """A shift of `semitones` with no key context -- the note letter follows the
  plain flat (or sharp) spelling of the interval, so +5 spells F:min7 as
  Bb:min7. Use `transpose_shift` instead whenever both keys are known."""
  semitones %= 12
  name = (SHARP_NAMES if prefer_sharps else FLAT_NAMES)[semitones]
  return Shift(NOTE_LETTERS.index(name[0]), semitones, prefer_sharps)


def transpose_harte_chord(chord_str: str, shift: Shift) -> str:
  """Transpose a chord by `shift`. Only the root moves: the shorthand, the
  extensions and the bass are all written relative to it. `N`, `%` and anything
  unparseable pass through untouched."""
  parts = split_harte_chord(chord_str)
  if parts is None:
    return chord_str
  letter, acc, n = parse_note(parts[0])
  new_root = spell_note(letter + shift.letters,
                        (LETTER_PC[letter] + acc + shift.semitones) % 12,
                        shift.prefer_sharps)
  return new_root + chord_str.strip()[n:]


def transpose_progression(changes, shift: Shift) -> list[str]:
  """Transpose a list of bar strings (space-separated beat tokens)."""
  return [" ".join(transpose_harte_chord(tok, shift) for tok in bar.split())
          for bar in changes]
