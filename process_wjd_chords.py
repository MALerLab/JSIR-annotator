import pandas as pd
import json
from jsd.chords import parse_wjd_chord, parse_cace_chord

df = pd.read_csv('chord_changes.csv')
df_orig = pd.read_csv('chord_changes_orig.csv')

df = df.sort_values(by=['title', 'performer', 'chord_changes'])
df_orig = df_orig.sort_values(by=['title', 'performer', 'chord_changes'])

data = []

for row, row_orig in zip(df.itertuples(), df_orig.itertuples()):
  chord_string = str(row.chord_changes)
  chord_string_orig = str(row_orig.chord_changes)

  if chord_string != chord_string_orig:
    chord_string = "|".join([line for line in chord_string.strip().replace("\n", "").split("||") if line and ":" not in line])
    chord_string_orig = "|".join([line for line in chord_string_orig.strip().replace("\n", "").split("||") if line and ":" not in line])

    measures = chord_string.split("|")
    measures_orig = chord_string_orig.split("|")
    measures_new = []
    for measure, measure_orig in zip(measures, measures_orig):
      if measure == measure_orig:
        measure_new = ""
        last = ""
        for char in measure:
          if char == " ":
            measure_new += " %"
          else:
            measure_new += char if last != " " else " " + char
          last = char
        measures_new.append(measure_new)
      else:
        chords = [chord for chord in measure.split(" ") if chord]
        measure_new = ""
        while len(measure_orig) > 0:
          if measure_orig[0] == " ":
            measure_new += "% "
            measure_orig = measure_orig[1:]
          else:
            if not measure_orig.startswith(chords[0]):
              print(row.title, row.performer)
              print("chords")
              print(chord_string)
              print("original")
              print(chord_string_orig)
              break
            measure_new += chords[0] + " "
            measure_orig = measure_orig[len(chords[0]):]
            chords = chords[1:]
        measures_new.append(measure_new)
            
  else:
    chord_string = "|".join([line for line in chord_string.strip().replace("\n", "").split("||") if line and ":" not in line])
    measures = chord_string.split("|")
    measures_new = []
    for measure in measures:
      measure_new = ""
      last = ""
      for char in measure:
        if char == " ":
          measure_new += " %"
        else:
          measure_new += char if last != " " else " " + char
        last = char
      measures_new.append(measure_new)

  data.append({
    "title": row.title,
    "performer": row.performer,
    "tempoclass": row.tempoclass,
    "rhythmfeel": row.rhythmfeel,
    "key": row.key if pd.notna(row.key) else None,
    "signature": row.signature if pd.notna(row.signature) else None,
    "chord_changes": measures_new
  })

with open("chord_progressions.json", "w") as f:
  json.dump(data, f, indent=2)