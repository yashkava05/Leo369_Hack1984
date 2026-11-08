"""Runtime settings loaded from the environment and the repo-root `.env`."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Later files win: a backend/.env overrides the shared repo-root .env.
        env_file=(_REPO_ROOT / ".env", _BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    ollama_host: str = "http://localhost:11434"
    latent_model: str = "qwen2.5vl:3b"
    tavily_api_key: str = ""
    exa_api_key: str = ""
    latent_mock: bool = False
    latent_watch_dir: str = ""  # opt-in screenshot folder (issue #20); empty = watcher off
    # Local intent library (issue #21): SQLite file, default ~/.latent/latent.db.
    latent_db_path: str = ""
    latent_keep_thumbs: bool = False  # store a 256 px JPEG thumbnail per saved job
    # Demo safety net (issue #17): a failed Tavily call is answered from recorded responses.
    demo_fallback: bool = False
    latent_stt_model_path: str = "~/.latent/models/faster-whisper-base.en"
    latent_stt_device: str = "cpu"
    latent_stt_compute_type: str = "int8"
    cors_origins: list[str] = ["http://localhost:5173"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
