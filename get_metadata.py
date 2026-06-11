from pathlib import Path
import json
import csv

recording_data = Path("all_recordings.csv")
with open(recording_data, "r") as f:
    reader = csv.DictReader(f)
    recordings = list(reader)

metadata = [
  {
    'yt_id': recording['yt_id'],
    'standard': recording['standard'],
    'artist': recording['artist'],
    'album': recording['album'],
    'instrumentation': recording['instrumentation'],
    'musicbrainz_id': recording['recording_mbid'],
    'files': {
      'audio': f"audio/{recording['yt_id']}.wav",
      'beats': f"beats/{recording['yt_id']}.txt"
    }
  }
  for recording in recordings
]

with open("metadata.json", "w") as f:
  json.dump(metadata, f, indent=2)