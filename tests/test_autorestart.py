import json
from pathlib import Path
from types import SimpleNamespace

from stitch_velly import service


def _prepare(tmp_path: Path, monkeypatch, enabled: bool) -> None:
    monkeypatch.setattr(service, "_directory", lambda: tmp_path)
    monkeypatch.setattr(service, "_process", None)
    monkeypatch.setattr(service, "_startup_error", None)
    monkeypatch.setattr(service, "_autorestart_at", 0.0)
    (tmp_path / "lifecycle.json").write_text(json.dumps({"enabled": enabled}))


def test_gateway_provider_restarts_dead_bridge_when_enabled(tmp_path, monkeypatch):
    _prepare(tmp_path, monkeypatch, enabled=True)

    def fake_start(params=None):
        monkeypatch.setattr(service, "_process", SimpleNamespace(poll=lambda: None))
        return {"running": True}

    monkeypatch.setattr(service, "start", fake_start)

    def fake_control(path, body=None):
        if path == "/control/provider":
            return {"models": {}, "options": {"baseURL": "http://127.0.0.1:38761/v1"}}
        return {"running": True, "rows": [], "refreshedAt": "2026-10-30T00:00:00Z"}

    monkeypatch.setattr(service, "_control", fake_control)

    bundle = service.gateway_provider()
    assert bundle["running"] is True


def test_gateway_provider_leaves_stopped_bridge_when_disabled(tmp_path, monkeypatch):
    _prepare(tmp_path, monkeypatch, enabled=False)
    calls = []
    monkeypatch.setattr(service, "start", lambda params=None: calls.append(params))

    bundle = service.gateway_provider()
    assert bundle["running"] is False
    assert calls == []


def test_autorestart_is_rate_limited_and_restores_lifecycle(tmp_path, monkeypatch):
    _prepare(tmp_path, monkeypatch, enabled=True)
    calls = []

    def failing_start(params=None):
        calls.append(params)
        (tmp_path / "lifecycle.json").write_text(json.dumps({"enabled": False}))
        raise RuntimeError("startup timed out")

    monkeypatch.setattr(service, "start", failing_start)

    assert service.gateway_provider()["running"] is False
    assert len(calls) == 1

    assert service.gateway_provider()["running"] is False
    assert len(calls) == 1

    assert json.loads((tmp_path / "lifecycle.json").read_text()) == {"enabled": True}

    monkeypatch.setattr(service, "_autorestart_at", 0.0)
    assert service.gateway_provider()["running"] is False
    assert len(calls) == 2
