#!/usr/bin/env bash
# Explicit setup is the only place permitted to download the STT model.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${LATENT_VOICE_PYTHON:-$ROOT/backend/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
    echo 'Set LATENT_VOICE_PYTHON to a Python environment with the backend voice extra installed.' >&2
    exit 1
fi
export PYTHONPATH="$ROOT/backend${PYTHONPATH:+:$PYTHONPATH}"
"$PYTHON" - <<'PY'
import asyncio
import io
import os
import wave
from pathlib import Path

from app.config import get_settings

from huggingface_hub import snapshot_download

# Pinned from https://huggingface.co/api/models/Systran/faster-whisper-base.en
REVISION = "3d3d5dee26484f91867d81cb899cfcf72b96be6c"
path = Path(get_settings().latent_stt_model_path).expanduser().resolve()
snapshot_download(
    repo_id="Systran/faster-whisper-base.en",
    revision=REVISION,
    local_dir=str(path),
    allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"],
)
# Smoke audio is synthetic silence, created and decoded only in memory.
os.environ["LATENT_STT_MODEL_PATH"] = str(path)
os.environ["LATENT_MOCK"] = "0"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
from app.voice import VoiceError, _load_model, transcribe_audio

get_settings.cache_clear()
_load_model()  # Ensure silence/VAD cannot skip the model-loading smoke check.
audio = io.BytesIO()
with wave.open(audio, "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(16000)
    wav.writeframes(b"\0\0" * 16000)
try:
    asyncio.run(transcribe_audio(audio.getvalue(), "audio/wav"))
except VoiceError as error:
    if error.code != "no_speech":
        raise SystemExit("Local voice smoke test failed") from None
print("Local voice model installed; in-memory offline smoke test passed.")
PY
