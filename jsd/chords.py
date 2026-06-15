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
  "G#": 7,
  "A": 9,
  "Ab": 7,
  "A#": 10,
  "B": 11,
  "Bb": 10,
  "B#": 0,
  "NC": None
}

qualities = {
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


def parse_chord(chord_str) -> tuple[Union[str, None], Union[str, None], Union[str, None], Union[str, None]]:
  if chord_str == "NC":
    return None, None, None, None

  if "/" in chord_str:
    chord_str, bass = chord_str.split("/")
  else:
    bass = None

  # find root note
  root = None
  for i in range(1, 3):
    if chord_str[:i] in roots:
      root = chord_str[:i]
  if root is None:
    raise ValueError(f"Invalid chord: {chord_str}")

  # find quality
  if chord_str[len(root):] == "":
    return root, None, bass, None
  
  quality = None
  for i in range (1, 5):
    if chord_str[len(root):len(root)+i] in qualities:
      quality = chord_str[len(root):len(root)+i]
      extensions = chord_str[len(root)+i:] if len(chord_str) > len(root) + i else None

  if quality is None:
    raise ValueError(f"Invalid chord quality: {chord_str[len(root):]} in chord {chord_str}")

  
  return root, quality, bass, extensions