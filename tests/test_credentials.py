import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from stitch_velly import service


def test_connection_metadata_does_not_read_or_return_secret_values(
    tmp_path, monkeypatch
):
    (tmp_path / "auth.bin").write_text("fixture-encrypted-api")
    (tmp_path / "secret-device-key.bin").write_text("fixture-encrypted-device")
    monkeypatch.setattr(service, "_shell_appdata", lambda: None)
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    monkeypatch.setattr(
        service, "_settings", lambda _: {"profile": str(tmp_path), "port": 38761}
    )
    monkeypatch.setattr(service, "_node", lambda _: "node.exe")
    monkeypatch.setattr(service, "_directory", lambda: tmp_path)
    data = service.connection_info()
    assert data["accessTokenPresent"] and data["deviceKeyPresent"]
    assert "fixture-encrypted" not in json.dumps(data)


def test_profile_resolution_falls_back_to_registry_appdata(tmp_path, monkeypatch):
    registry = tmp_path / "registry" / "Velly"
    registry.mkdir(parents=True)
    (registry / "auth.bin").write_text("x")
    (registry / "Local State").write_text("{}")
    monkeypatch.setattr(service, "_shell_appdata", lambda: tmp_path / "registry")
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    configured = tmp_path / "sandbox"
    assert service._velly_profile({"profile": str(configured)}) == registry.resolve()


def test_profile_resolution_keeps_configured_when_no_storage_anywhere(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(service, "_shell_appdata", lambda: tmp_path / "registry")
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    configured = tmp_path / "sandbox"
    assert service._velly_profile({"profile": str(configured)}) == configured.resolve()


def test_export_returns_only_file_metadata_and_does_not_expose_subprocess_errors(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(service, "_settings", lambda _: {"profile": str(tmp_path)})
    monkeypatch.setattr(service, "_node", lambda _: "node.exe")
    monkeypatch.setattr(service, "_directory", lambda: tmp_path)
    calls = []

    def run(*args, **kwargs):
        calls.append(json.loads(kwargs["input"]))
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"path": "fixture.json", "fields": ["access_token"]}),
        )

    monkeypatch.setattr(service.subprocess, "run", run)
    assert service.export_secrets({}) == {
        "path": "fixture.json",
        "fields": ["access_token"],
    }
    assert calls[0]["includeDeviceKey"] is False
    with pytest.raises(ValueError):
        service.export_secrets({"includeDeviceKey": "true"})
    monkeypatch.setattr(
        service.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(returncode=1, stderr="fixture-secret"),
    )
    with pytest.raises(RuntimeError) as caught:
        service.export_secrets({})
    assert "fixture-secret" not in str(caught.value)
