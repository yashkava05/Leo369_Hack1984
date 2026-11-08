"""Runtime settings loaded from the environment and local dotenv files."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Local secrets override shared defaults; backend-specific files win within each tier.
        env_file=(
            _REPO_ROOT / ".env",
            _BACKEND_DIR / ".env",
            _REPO_ROOT / ".env.local",
            _BACKEND_DIR / ".env.local",
        ),
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
    # Browser-session agent (issue #67): extension IDs allowed to use the local bridge. The
    # default is the stable ID of the unpacked extension in browser-extension/ (manifest key).
    latent_extension_ids: list[str] = ["kemjkilbmidnkohlldbohmgjaljbkdcc"]
    # Per-launch UI secret file for the browser agent; default: next to the library DB.
    latent_ui_secret_path: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
