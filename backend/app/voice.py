"""Memory-only local Whisper adapter. Model installation is an explicit setup step."""

from __future__ import annotations

import asyncio
import io
import re
import threading
import wave
from pathlib import Path

from app.config import get_settings

MAX_AUDIO_BYTES = 8 * 1024 * 1024
SAMPLE_RATE = 16000
MAX_SAMPLES = 30 * SAMPLE_RATE
MAX_TRANSCRIPT_CHARS = 1000
MOCK_TRANSCRIPT = "Find AI events in Boston this weekend"
_PARAMETER = re.compile(
    r'\s*[!#$%&\'*+.^_`|~\w-]+\s*=\s*(?:[!#$%&\'*+.^_`|~\w-]+|"[^"\r\n]*")\s*',
    re.ASCII,
)
_model = None
_model_lock = threading.Lock()
_inference = asyncio.Semaphore(1)
_ERRORS = {
    "audio_too_large": 413,
    "unsupported_audio": 415,
    "audio_too_long": 422,
    "no_speech": 422,
    "voice_model_unavailable": 503,
}


class VoiceError(Exception):
    """Only allow constant public error codes; never carry decoder/model messages."""

    def __init__(self, code: str):
        if code not in _ERRORS:
            code = "voice_model_unavailable"
        self.code = code
        self.status = self.status_code = _ERRORS[code]
        super().__init__(code)


def validate_audio(data: bytes, content_type: str) -> str:
    """Validate size, MIME syntax and matching container magic, including in mock mode."""
    if len(data) > MAX_AUDIO_BYTES:
        raise VoiceError("audio_too_large")
    if not isinstance(content_type, str) or len(content_type) > 512:
        raise VoiceError("unsupported_audio")
    parts = content_type.split(";")
    kind = parts[0].strip().lower()
    if any(not _PARAMETER.fullmatch(part) for part in parts[1:]):
        raise VoiceError("unsupported_audio")
    valid = {
        "audio/webm": data.startswith(b"\x1aE\xdf\xa3"),
        "audio/mp4": len(data) >= 12 and data[4:8] == b"ftyp",
        "audio/ogg": data.startswith(b"OggS"),
        "audio/wav": len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE",
    }
    if not data or not valid.get(kind, False):
        raise VoiceError("unsupported_audio")
    return kind


def _load_model():
    global _model
    with _model_lock:
        if _model is None:
            settings = get_settings()
            # Resolve to an absolute, existing directory before calling the SDK. Never a repo ID.
            path = Path(settings.latent_stt_model_path).expanduser().resolve()
            required = ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt")
            if not path.is_dir() or not all((path / name).is_file() for name in required):
                raise VoiceError("voice_model_unavailable")
            from faster_whisper import WhisperModel

            _model = WhisperModel(
                str(path),
                device=settings.latent_stt_device,
                compute_type=settings.latent_stt_compute_type,
                local_files_only=True,
            )
        return _model


def _decode_audio(data: bytes):
    """Stream frames into bounded mono 16 kHz PCM; never trust duration metadata."""
    import av
    import numpy as np

    chunks = []
    count = 0

    def append(frames):
        nonlocal count
        for frame in frames:
            count += frame.samples
            if count > MAX_SAMPLES:
                raise VoiceError("audio_too_long")
            chunks.append(frame.to_ndarray().reshape(-1))

    try:
        # Container metadata must not trigger external references or FFmpeg diagnostics.
        with (
            av.logging.Capture(),
            av.open(
                io.BytesIO(data),
                mode="r",
                options={
                    "protocol_whitelist": "pipe",
                    "enable_drefs": "0",
                    "use_absolute_path": "0",
                },
            ) as container,
        ):
            if not container.streams.audio:
                raise VoiceError("unsupported_audio")
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(format="fltp", layout="mono", rate=SAMPLE_RATE)
            for frame in container.decode(stream):
                append(resampler.resample(frame))
            append(resampler.resample(None))
    except VoiceError:
        raise
    except Exception:
        raise VoiceError("unsupported_audio") from None
    if not count:
        raise VoiceError("no_speech")
    return np.concatenate(chunks).astype(np.float32, copy=False), count


def _mock_wav_samples(data: bytes) -> int:
    """The dependency-free mock still validates PCM frames, not just the WAV header."""
    try:
        with wave.open(io.BytesIO(data), "rb") as audio:
            width = audio.getsampwidth() * audio.getnchannels()
            rate = audio.getframerate()
            frames = len(audio.readframes(30 * rate + 1)) // width
            if frames > 30 * rate:
                raise VoiceError("audio_too_long")
            if not frames:
                raise VoiceError("no_speech")
            return frames * SAMPLE_RATE // rate
    except VoiceError:
        raise
    except Exception:
        raise VoiceError("unsupported_audio") from None


def _transcribe(data: bytes, kind: str, filename: str) -> dict:
    mock = get_settings().latent_mock
    # WAV mocks work without optional AV/Whisper; other containers use the real bounded decoder.
    if mock and kind == "audio/wav":
        count = _mock_wav_samples(data)
        audio = None
    else:
        audio, count = _decode_audio(data)
    if mock:
        if "silence" in filename.casefold():
            raise VoiceError("no_speech")
        text = MOCK_TRANSCRIPT
    else:
        segments, _ = _load_model().transcribe(
            audio,
            language="en",
            vad_filter=True,
            beam_size=1,
            word_timestamps=False,
            without_timestamps=True,
        )
        text = " ".join(segment.text for segment in segments)
    text = " ".join(text.split())[:MAX_TRANSCRIPT_CHARS].rstrip()
    if not text:
        raise VoiceError("no_speech")
    return {"transcript": text, "language": "en", "duration_ms": count * 1000 // SAMPLE_RATE}


def _safe_transcribe(data: bytes, kind: str, filename: str) -> dict | str:
    # Never let a worker exception (or its private traceback/context) reach asyncio's logger.
    try:
        return _transcribe(data, kind, filename)
    except VoiceError as exc:
        return exc.code
    except Exception:
        return "voice_model_unavailable"


async def transcribe_audio(data: bytes, content_type: str, *, filename: str = "") -> dict:
    """Return local transcript/language/duration, or raise a constant-only VoiceError."""
    kind = validate_audio(data, content_type)

    async def serialized():
        async with _inference:
            return await asyncio.to_thread(_safe_transcribe, data, kind, filename)

    # Shield the lock owner, not just to_thread: cancellation must not release the semaphore
    # while native inference is running. The worker returns safe values even after cancellation.
    task = asyncio.create_task(serialized())
    outcome = await asyncio.shield(task)
    if isinstance(outcome, str):
        raise VoiceError(outcome)
    return outcome
