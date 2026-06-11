from pathlib import Path
import subprocess

audio_fns = sorted(Path('audio').glob('*.wav'))
beats_dir = Path('beats')
beats_dir.mkdir(exist_ok=True)

for i, audio_fn in enumerate(audio_fns):
  beat_fn = beats_dir / (audio_fn.stem + '.txt')
  if beat_fn.exists():
    print(f'[skip] {audio_fn} ({i+1}/{len(audio_fns)})')
    continue
  print(f'[process] {audio_fn} ({i+1}/{len(audio_fns)})')
  cmd = [
    'DBNBeatTracker', 'single', '-o', str(beat_fn), str(audio_fn)
  ]
  subprocess.run(cmd)