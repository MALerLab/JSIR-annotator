from pathlib import Path
import json
import csv
import wave

recording_data = Path("all_recordings.csv")
with open(recording_data, "r") as f:
    reader = csv.DictReader(f)
    recordings = list(reader)


def get_audio_length(audio_path):
    with wave.open(str(audio_path), "rb") as wav:
        return wav.getnframes() / wav.getframerate()


metadata = [
  {
    'yt_id': recording['yt_id'],
    'standard': recording['standard'],
    'artist': recording['artist'],
    'album': recording['album'],
    'instrumentation': recording['instrumentation'],
    'musicbrainz_id': recording['recording_mbid'],
    'audio_length': get_audio_length(f"audio/{recording['yt_id']}.wav"),
    'files': {
      'audio': f"audio/{recording['yt_id']}.wav",
      'beats': f"beats/{recording['yt_id']}.txt",
      'cace_chords': f"consonance_ace_inferences/{recording['yt_id']}.lab",
      'chords': f"chords/{recording['yt_id']}.csv",
    }
  }
  for recording in recordings
  if recording['yt_id'] and Path(f"audio/{recording['yt_id']}.wav").exists() and Path(f"chords/{recording['yt_id']}.csv").exists()
]

with open("metadata.json", "w") as f:
  json.dump(metadata, f, indent=2)