"""Local audio validation, bounded decoding and cancellation/privacy guarantees."""

import asyncio
import io
import sys
import threading
import wave
from contextlib import nullcontext
from types import SimpleNamespace

import numpy as np
import pytest

from app import voice


def wav_bytes(seconds=1):
    out = io.BytesIO()
    with wave.open(out, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0\0" * int(16000 * seconds))
    return out.getvalue()


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    settings = SimpleNamespace(
        latent_mock=False,
        latent_stt_model_path=str(tmp_path / "missing"),
        latent_stt_device="cpu",
        latent_stt_compute_type="int8",
    )
    monkeypatch.setattr(voice, "get_settings", lambda: settings)
    monkeypatch.setattr(voice, "_model", None)
    monkeypatch.setattr(voice, "_inference", asyncio.Semaphore(1))
    return settings


@pytest.mark.parametrize(
    ("data", "mime"),
    [
        (b"\x1aE\xdf\xa3rest", 'audio/webm; codecs="opus"'),
        (b"\0\0\0\x18ftypisom", "audio/mp4; codecs=mp4a.40.2"),
        (b"OggSrest", "audio/ogg"),
        (wav_bytes(), "Audio/WAV"),
    ],
)
def test_signatures(data, mime):
    assert voice.validate_audio(data, mime).startswith("audio/")


@pytest.mark.parametrize(
    ("data", "mime", "code", "status"),
    [
        (b"", "audio/wav", "unsupported_audio", 415),
        (wav_bytes(), "audio/webm", "unsupported_audio", 415),
        (b"RIFFbad", "audio/wav", "unsupported_audio", 415),
        (wav_bytes(), "text/plain", "unsupported_audio", 415),
        (wav_bytes(), "audio/wav; codecs", "unsupported_audio", 415),
        (wav_bytes(), 'audio/wav; codecs="pcm\r\nprivate"', "unsupported_audio", 415),
        (b"x" * (voice.MAX_AUDIO_BYTES + 1), "audio/wav", "audio_too_large", 413),
    ],
)
async def test_rejected_before_mock_or_model(isolated, data, mime, code, status):
    isolated.latent_mock = True
    with pytest.raises(voice.VoiceError) as error:
        await voice.transcribe_audio(data, mime)
    assert (str(error.value), error.value.code, error.value.status) == (code, code, status)


async def test_mock_wav_requires_no_optional_imports(isolated, monkeypatch):
    isolated.latent_mock = True
    monkeypatch.setitem(sys.modules, "av", None)
    monkeypatch.setitem(sys.modules, "faster_whisper", None)
    result = await voice.transcribe_audio(wav_bytes(), "audio/wav", filename="event.wav")
    assert result == {
        "transcript": "Find AI events in Boston this weekend",
        "language": "en",
        "duration_ms": 1000,
    }
    with pytest.raises(voice.VoiceError, match="no_speech"):
        await voice.transcribe_audio(wav_bytes(), "audio/wav", filename="silence.wav")
    with pytest.raises(voice.VoiceError, match="audio_too_long"):
        await voice.transcribe_audio(wav_bytes(30.001), "audio/wav")
    with pytest.raises(voice.VoiceError, match="unsupported_audio"):
        await voice.transcribe_audio(b"RIFF0000WAVEgarbage", "audio/wav")


def fake_av(monkeypatch, sizes, *, audio=True, flush=0, error=None):
    class Frame:
        def __init__(self, size):
            self.samples = size

        def to_ndarray(self):
            return np.zeros((1, self.samples), dtype=np.float32)

    class Container:
        duration = 0  # deliberately lies; decoded sample counts are authoritative
        streams = SimpleNamespace(audio=[object()] if audio else [])

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def decode(self, stream):
            for size in sizes:
                yield Frame(size)
            if error:
                raise error

    def open_memory(source, mode, options):
        assert isinstance(source, io.BytesIO) and mode == "r"
        assert options == {
            "protocol_whitelist": "pipe",
            "enable_drefs": "0",
            "use_absolute_path": "0",
        }
        return Container()

    class Resampler:
        def __init__(self, **kwargs):
            assert kwargs == {"format": "fltp", "layout": "mono", "rate": 16000}

        def resample(self, frame):
            return [frame] if frame else ([Frame(flush)] if flush else [])

    monkeypatch.setitem(
        sys.modules,
        "av",
        SimpleNamespace(
            open=open_memory,
            AudioResampler=Resampler,
            logging=SimpleNamespace(Capture=nullcontext),
        ),
    )


@pytest.mark.parametrize("sizes,flush", [([16000] * 31, 0), ([480000], 1)])
async def test_counts_resampled_frames_and_flush_not_metadata(monkeypatch, sizes, flush):
    fake_av(monkeypatch, sizes, flush=flush)
    with pytest.raises(voice.VoiceError) as error:
        await voice.transcribe_audio(wav_bytes(), "audio/wav")
    assert (error.value.status, error.value.code) == (422, "audio_too_long")


async def test_exact_30_seconds_accepted(monkeypatch, isolated):
    fake_av(monkeypatch, [480000])
    isolated.latent_mock = True
    assert (await voice.transcribe_audio(b"OggSdata", "audio/ogg"))["duration_ms"] == 30000


@pytest.mark.parametrize(
    "audio,sizes,code", [(False, [], "unsupported_audio"), (True, [], "no_speech")]
)
async def test_no_audio(monkeypatch, audio, sizes, code):
    fake_av(monkeypatch, sizes, audio=audio)
    with pytest.raises(voice.VoiceError, match=code):
        await voice.transcribe_audio(wav_bytes(), "audio/wav")


async def test_missing_model_fails_closed(monkeypatch):
    fake_av(monkeypatch, [16000])
    monkeypatch.setitem(sys.modules, "faster_whisper", None)
    with pytest.raises(voice.VoiceError) as error:
        await voice.transcribe_audio(wav_bytes(), "audio/wav")
    assert (error.value.status, str(error.value)) == (503, "voice_model_unavailable")
    assert error.value.__context__ is None


def test_local_path_only_and_singleton(monkeypatch, isolated, tmp_path):
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    for name in ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt"):
        (model_dir / name).touch()
    isolated.latent_stt_model_path = str(model_dir)
    calls = []

    def constructor(path, **kwargs):
        calls.append((path, kwargs))
        return object()

    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=constructor))
    assert voice._load_model() is voice._load_model()
    assert calls == [
        (
            str(model_dir.resolve()),
            {"device": "cpu", "compute_type": "int8", "local_files_only": True},
        )
    ]


@pytest.mark.parametrize("path", ["base.en", "Systran/faster-whisper-base.en", "https://hf.co/x"])
def test_model_ids_urls_never_reach_sdk(isolated, path, monkeypatch):
    isolated.latent_stt_model_path = path
    monkeypatch.setitem(sys.modules, "faster_whisper", None)
    with pytest.raises(voice.VoiceError, match="voice_model_unavailable"):
        voice._load_model()


async def test_transcription_options_and_normalization(monkeypatch):
    fake_av(monkeypatch, [16000])

    def transcribe(audio, **options):
        assert isinstance(audio, np.ndarray) and audio.shape == (16000,)
        assert options == {
            "language": "en",
            "vad_filter": True,
            "beam_size": 1,
            "word_timestamps": False,
            "without_timestamps": True,
        }
        return iter([SimpleNamespace(text="  hello\n  world " + "x" * 1100)]), object()

    monkeypatch.setattr(voice, "_load_model", lambda: SimpleNamespace(transcribe=transcribe))
    result = await voice.transcribe_audio(wav_bytes(), "audio/wav")
    assert result["transcript"].startswith("hello world ")
    assert len(result["transcript"]) == 1000


@pytest.mark.parametrize("failure", ["decoder", "model", "segments", "silence"])
async def test_worker_errors_never_expose_private_context(monkeypatch, caplog, failure):
    secret = "private audio transcript fake.person@example.test"
    fake_av(monkeypatch, [16000], error=RuntimeError(secret) if failure == "decoder" else None)

    def transcribe(*args, **kwargs):
        if failure == "model":
            raise RuntimeError(secret)

        def segments():
            if failure == "segments":
                raise RuntimeError(secret)
            yield SimpleNamespace(text=" \n ")

        return segments(), object()

    monkeypatch.setattr(voice, "_load_model", lambda: SimpleNamespace(transcribe=transcribe))
    with pytest.raises(voice.VoiceError) as error:
        await voice.transcribe_audio(wav_bytes(), "audio/wav", filename=secret)
    assert secret not in str(error.value) + caplog.text
    assert error.value.__context__ is None and error.value.__cause__ is None


async def test_cancellation_holds_semaphore_until_worker_finishes(monkeypatch, caplog):
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def worker(*args):
        calls.append(1)
        if len(calls) == 1:
            entered.set()
            assert release.wait(3)
            raise RuntimeError("private cancelled transcript")
        return {"transcript": "second", "language": "en", "duration_ms": 1000}

    monkeypatch.setattr(voice, "_transcribe", worker)
    first = asyncio.create_task(voice.transcribe_audio(wav_bytes(), "audio/wav"))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        second = asyncio.create_task(voice.transcribe_audio(wav_bytes(), "audio/wav"))
        await asyncio.sleep(0.05)
        assert len(calls) == 1
        assert voice._inference.locked()
    finally:
        release.set()
    assert (await asyncio.wait_for(second, 2))["transcript"] == "second"
    assert "private cancelled transcript" not in caplog.text


async def test_real_av_decodes_synthetic_wav_if_installed(isolated):
    pytest.importorskip("av")
    isolated.latent_mock = True
    audio, count = await asyncio.to_thread(voice._decode_audio, wav_bytes())
    assert count == 16000 and audio.shape == (16000,)


@pytest.mark.parametrize(
    "container,codec,mime",
    [
        ("webm", "libopus", "audio/webm"),
        ("mp4", "aac", "audio/mp4"),
        ("ogg", "libopus", "audio/ogg"),
    ],
)
async def test_real_av_browser_formats_in_memory(isolated, container, codec, mime):
    av = pytest.importorskip("av")
    out = io.BytesIO()
    with av.open(out, "w", format=container) as encoded:
        stream = encoded.add_stream(codec, rate=48000)
        stream.layout = "mono"
        frame = av.AudioFrame.from_ndarray(
            np.zeros((1, 48000), dtype=np.float32), format="fltp", layout="mono"
        )
        frame.sample_rate = 48000
        for packet in stream.encode(frame):
            encoded.mux(packet)
        for packet in stream.encode(None):
            encoded.mux(packet)
    isolated.latent_mock = True
    result = await voice.transcribe_audio(out.getvalue(), mime)
    assert result["transcript"] == voice.MOCK_TRANSCRIPT
    assert 950 <= result["duration_ms"] <= 1100


async def test_mock_audio_never_written(isolated, monkeypatch):
    import builtins
    import tempfile

    data = wav_bytes()
    isolated.latent_mock = True

    def forbidden(*args, **kwargs):
        pytest.fail("audio attempted filesystem access")

    monkeypatch.setattr(builtins, "open", forbidden)
    monkeypatch.setattr(tempfile, "TemporaryFile", forbidden)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", forbidden)
    monkeypatch.setattr(tempfile, "SpooledTemporaryFile", forbidden)
    assert (await voice.transcribe_audio(data, "audio/wav"))["transcript"] == voice.MOCK_TRANSCRIPT
