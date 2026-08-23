from typing import Union


roots = {
  "C": 0,
  "Cb": 11,
  "C#": 1,
  "D": 2,
  "Db": 1, 
  "D#": 3,
  "E": 4,
  "Eb": 3,
  "E#": 5,
  "F": 5,
  "Fb": 4,
  "F#": 6,
  "G": 7,
  "Gb": 6,
  "G#": 8,
  "A": 9,
  "Ab": 8,
  "A#": 10,
  "B": 11,
  "Bb": 10,
  "B#": 0
}

idx2root = {
  0: "C",
  1: "C#",
  2: "D",
  3: "D#",
  4: "E",
  5: "F",
  6: "F#",
  7: "G",
  8: "G#",
  9: "A",
  10: "A#",
  11: "B"
}

wjd_degrees = {
  "1": 0,
  "3b": 3,
  "3": 4,
  "4": 5,
  "5b": 6,
  "5": 7,
  "6b": 8,
  "6": 9,
  "7b": 10,
  "7": 11,
  "9": 2,
  "9b": 1,
  "9#": 3,
  "11": 5,
  "11b": 4,
  "11#": 6,
  "13b": 8,
  "13": 9,
}

cace_degrees = {
  "1": 0,
  "b3": 3,
  "3": 4,
  "4": 5,
  "b5": 6,
  "5": 7,
  "b6": 8,
  "6": 9,
  "b7": 10,
  "7": 11,
  "9": 2,
  "b9": 1,
}


wjd_qualities = {
  "j": [0, 4, 7],
  "-": [0, 3, 7],
  "j7": [0, 4, 7, 11],
  "-7": [0, 3, 7, 10],
  "-j7": [0, 3, 7, 11],
  "7": [0, 4, 7, 10],
  "7alt": [0, 4, 7, 10, 11],
  "+": [0, 4, 8],
  "+7": [0, 4, 8, 10],
  "+j7": [0, 4, 8, 11],
  "o": [0, 3, 6],
  "o7": [0, 3, 6, 9],
  "6": [0, 4, 7, 9],
  "-6": [0, 3, 7, 9],
  "9": [0, 4, 7, 10, 14],
  "m7b5": [0, 3, 6, 10],
  "sus": [0, 5, 7],
  "sus7": [0, 5, 7, 10],
  "69": [0, 4, 7, 9, 14],
  "-69": [0, 3, 7, 9, 14],
}

cace_qualities = {
  "maj": [0, 4, 7],
  "min": [0, 3, 7],
  "maj7": [0, 4, 7, 11],
  "maj9": [0, 4, 7, 11, 14],
  "min7": [0, 3, 7, 10],
  "min9": [0, 3, 7, 10, 14],
  "minmaj7": [0, 3, 7, 11],
  "hdim7": [0, 3, 6, 10],
  "7": [0, 4, 7, 10],
  "dim": [0, 3, 6],
  "maj6": [0, 4, 7, 9],
  "min6": [0, 3, 7, 9],
  "9": [0, 4, 7, 10, 14],
  "sus4": [0, 5, 7],
}


def parse_wjd_chord(chord_str) -> tuple[Union[int, None], Union[list[int], None], Union[int, None], Union[list[int], None]]:
  if chord_str == "NC":
    return None, None, None, None

  if "/" in chord_str:
    chord_str, bass = chord_str.split("/")
    bass = roots.get(bass)
  else:
    bass = None

  # find root note
  root = None
  for i in range(1, 3):
    if chord_str[:i] in roots:
      root = roots[chord_str[:i]]
      root_str = chord_str[:i]
  if root is None:
    raise ValueError(f"Invalid chord: {chord_str}")

  # find quality
  if chord_str[len(root_str):] == "":
    return root, [0, 4, 7], bass, None
  
  quality = None
  for i in range (1, 5):
    if chord_str[len(root_str):len(root_str)+i] in wjd_qualities:
      quality = chord_str[len(root_str):len(root_str)+i]
      extension_str = chord_str[len(root_str)+i:] if len(chord_str) > len(root_str) + i else None

  if quality is None:
    raise ValueError(f"Invalid chord quality: {chord_str[len(root_str):]} in chord {chord_str}")

  quality = wjd_qualities[quality]
  
  extensions = []
  # in this version, extensions are written with no separator, e.g. "C7911" instead of "C7(9,11)"
  if extension_str is None:
    return root, quality, bass, None
  
  while len(extension_str) > 0:
    extension_candidate = None
    last_i = 0
    for i in range(1, 4):
      if extension_str[:i] in wjd_degrees:
        extension_candidate = wjd_degrees[extension_str[:i]]
        last_i = i
    extensions.append(extension_candidate)
    extension_str = extension_str[last_i:]
  
  return root, quality, bass, extensions


def parse_cace_chord(chord_str) -> tuple[Union[int, None], Union[list[int], None], Union[int, None], Union[list[int], None]]:
  if chord_str == "N":
    return None, None, None, None

  if "/" in chord_str:
    chord_str, bass = chord_str.split("/")
    bass = cace_degrees.get(bass)
  else:
    bass = None

  # find root note
  root_str = chord_str.split(":")[0]
  root = roots.get(root_str)
  if root is None:
    raise ValueError(f"Invalid chord: {chord_str}")

  quality_str = chord_str[len(root_str)+1:]

  # find quality
  if chord_str[len(root_str)+1:] == "":
    return root, None, bass, None

  quality = None
  extensions = None
  if quality_str.startswith("("):
    quality = [cace_degrees[note] for note in quality_str[1:-1].split(",") if note in cace_degrees]
  else:
    for i in range (1, 8):
      if len(quality_str) < i:
        break
      if quality_str[:i] in cace_qualities:
        quality = cace_qualities[quality_str[:i]]
        extensions = [cace_degrees[note] for note in quality_str[i+1:-1].split(",")] if len(quality_str) > i and quality_str[i] == "(" else None

  if quality is None:
    raise ValueError(f"Invalid chord quality: {chord_str[len(root_str)+1:]} in chord {chord_str}")

  return root, quality, bass, extensions


def transpose_wjd_chord_string(chord_string: str, semitones: int) -> str:
  root, quality, bass, extensions = parse_wjd_chord(chord_string)
  if root is None:
    return "NC"
  rest_string = chord_string[len(str(root)):]
  return f"{idx2root[(root + semitones) % 12]}{rest_string}"


# --------------------------------------------------------------------------- #
# Key comparison + transposition (added for chord-progression insertion)
#
# The original transpose_wjd_chord_string above slices with len(str(root)) --
# the length of the *integer* pitch class -- so it mangles two-char roots such
# as "Ab"/"Db" (whose pitch class is a single digit) and leaves slash-chord
# basses untransposed. The functions below fix both and add key handling.
# --------------------------------------------------------------------------- #
def _root_prefix(s: str):
  """Return (root_str, pitch_class) for the longest root-note prefix of `s`,
  else (None, None)."""
  for i in (2, 1):
    if len(s) >= i and s[:i] in roots:
      return s[:i], roots[s[:i]]
  return None, None


def transpose_wjd_chord(chord_string: str, semitones: int) -> str:
  """Transpose a WJD chord string, preserving quality/extensions and
  transposing the bass of slash chords. '%' (hold) and no-chord pass through."""
  if chord_string in ("%", "NC", "N", "", None):
    return chord_string
  main, _, bass = chord_string.partition("/")
  rstr, rpc = _root_prefix(main)
  if rstr is None:
    return chord_string  # unparseable -> leave untouched
  out = idx2root[(rpc + semitones) % 12] + main[len(rstr):]
  if bass:
    bstr, bpc = _root_prefix(bass)
    out += "/" + (idx2root[(bpc + semitones) % 12] + bass[len(bstr):] if bstr else bass)
  return out


def parse_key(key_str):
  """Parse a key label into (pitch_class, mode). Accepts lead-sheet form
  ('Ab-maj', 'C-min') and spoken form ('D major', 'F minor'). mode is
  'maj'/'min'; pitch_class is 0-11 (or None if unknown)."""
  if not key_str:
    return None, None
  s = str(key_str).strip()
  if "-" in s:
    root_part, mode_part = s.split("-", 1)
  else:
    parts = s.split()
    root_part, mode_part = parts[0], (parts[1] if len(parts) > 1 else "")
  pc = roots.get(root_part.strip())
  mode = "min" if mode_part.strip().lower().startswith("min") else "maj"
  return pc, mode


def semitones_between(from_key, to_key):
  """Semitones to shift chords written in `from_key` so they sound in `to_key`
  (tonic pitch-class difference, 0-11). None if either key is unknown."""
  a, _ = parse_key(from_key)
  b, _ = parse_key(to_key)
  if a is None or b is None:
    return None
  return (b - a) % 12


def transpose_progression(changes, semitones):
  """Transpose a list of bar strings (space-separated beat tokens)."""
  return [
    " ".join(transpose_wjd_chord(tok, semitones) for tok in bar.split())
    for bar in changes
  ]