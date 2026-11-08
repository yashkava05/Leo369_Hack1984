from app.config import Settings


def test_local_dotenv_overrides_defaults_but_environment_wins(tmp_path, monkeypatch):
    assert [path.name for path in Settings.model_config["env_file"]] == [
        ".env",
        ".env",
        ".env.local",
        ".env.local",
    ]
    monkeypatch.delenv("EXA_API_KEY", raising=False)
    paths = tuple(
        tmp_path / name
        for name in ("root.env", "backend.env", "root.env.local", "backend.env.local")
    )
    for index, path in enumerate(paths):
        path.write_text(f"EXA_API_KEY=fake-config-key-{index}\n")
    monkeypatch.setitem(Settings.model_config, "env_file", paths)
    assert Settings().exa_api_key == "fake-config-key-3"
    paths[-1].unlink()
    assert Settings().exa_api_key == "fake-config-key-2"
    monkeypatch.setenv("EXA_API_KEY", "fake-shell-key")
    assert Settings().exa_api_key == "fake-shell-key"
