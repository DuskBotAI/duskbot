"""Remove the voice from a clip with Demucs (htdemucs, MIT): python separate.py <in.wav> <music-out.wav>"""
import os
import subprocess
import sys

import numpy as np
import soundfile
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model


def main(source, target):
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    model = get_model("htdemucs")
    model.eval()
    # demucs's own CLI saves through torchaudio, which since 2.9 needs torchcodec; read and write with ffmpeg and soundfile instead.
    raw = subprocess.check_output([os.environ.get("FFMPEG", "ffmpeg"), "-v", "error", "-i", source, "-f", "f32le", "-ac", "2", "-ar", str(model.samplerate), "-"])
    wav = torch.from_numpy(np.frombuffer(raw, dtype=np.float32).copy().reshape(-1, 2).T)
    reference = wav.mean(0)
    mean, std = reference.mean(), reference.std() + 1e-8
    with torch.no_grad():
        sources = apply_model(model, ((wav - mean) / std)[None], shifts=0, split=True, overlap=0.1, progress=False)[0]
    sources = sources * std + mean
    music = sum(sources[i] for i, name in enumerate(model.sources) if name != "vocals")
    peak = float(music.abs().max()) or 1.0
    soundfile.write(target, (music / peak * 0.9).T.numpy(), model.samplerate)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
