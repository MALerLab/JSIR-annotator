from pathlib import Path
import shutil
import json
from tqdm.auto import tqdm

EXPORT_DIR = Path("/home/issyun/storage/JSIR")

with open("metadata.json") as f:
  metadata = json.load(f)

metadata = [x for x in metadata if x["completed"] == True]

try:
  EXPORT_DIR.mkdir(parents=True, exist_ok=True)
  print(f"Exporting {len(metadata)} items to {EXPORT_DIR}")

  print("Copying audio...")
  audio_dir = EXPORT_DIR / "audio"
  audio_dir.mkdir(parents=True, exist_ok=True)
  for item in tqdm(metadata, desc="Exporting"):
    src = Path(item["files"]["audio"])
    dst = audio_dir / src.name
    shutil.copy(src, dst)
    if "sections" in item["files"]:
      del metadata[metadata.index(item)]["files"]["sections"]

  print("Copying labels...")
  beats_dir = EXPORT_DIR / "beats"
  chords_dir = EXPORT_DIR / "chords"
  structure_dir = EXPORT_DIR / "structure"
  segments_dir = EXPORT_DIR / "segments"
  for dir in [beats_dir, chords_dir, structure_dir, segments_dir]:
    dir.mkdir(parents=True, exist_ok=True)
    for file in dir.iterdir():
      if file.is_file():
        file.unlink()
  
  for item in tqdm(metadata, desc="Exporting"):
    if "beats" not in item["files"]:
      item["files"]["beats"] = f"beats/{Path(item['yt_id']).with_suffix('.txt')}"
    src = Path(item["files"]["beats"])
    dst = beats_dir / src.name
    shutil.copy(src, dst)

    if "chords" not in item["files"]:
      item["files"]["chords"] = f"chords/{Path(item['yt_id']).with_suffix('.csv')}"
    src = Path(item["files"]["chords"])
    dst = chords_dir / src.name
    shutil.copy(src, dst)

    if "structure" not in item["files"]:
      item["files"]["structure"] = f"structure/{Path(item['yt_id']).with_suffix('.csv')}"
    src = Path(item["files"]["structure"])
    dst = structure_dir / src.name
    shutil.copy(src, dst)

    if "segments" not in item["files"]:
      item["files"]["segments"] = f"segments/{Path(item['yt_id']).with_suffix('.csv')}"
    src = Path(item["files"]["segments"])
    dst = segments_dir / src.name
    shutil.copy(src, dst)

  with open(EXPORT_DIR / "audio" / ".gitignore", "w") as f:
    f.write("*")

  print("Exporting metadata...")
  standards = set([x["standard"].lower() for x in metadata])
  with open("lead_sheets.json") as f:
    lead_sheets = json.load(f)
  lead_sheets = [x for x in lead_sheets if x["title"].lower() in standards]

  metadata.sort(key=lambda x: x["standard"].lower())
  lead_sheets.sort(key=lambda x: x["title"].lower())

  with open(EXPORT_DIR / "metadata.json", "w") as f:
    json.dump(metadata, f, indent=2)

  with open(EXPORT_DIR / "lead_sheets.json", "w") as f:
    json.dump(lead_sheets, f, indent=2)

except Exception as e:
  print(f"Error: {e}")
  print("Cleaning up...")
  beats_dir = EXPORT_DIR / "beats"
  chords_dir = EXPORT_DIR / "chords"
  structure_dir = EXPORT_DIR / "structure"
  segments_dir = EXPORT_DIR / "segments"
  for dir in [beats_dir, chords_dir, structure_dir, segments_dir]:
    if dir.exists():
      for file in dir.iterdir():
        if file.is_file():
          file.unlink()