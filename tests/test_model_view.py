from stitch_velly import service


def test_model_view_preserves_history_without_claiming_live_health(monkeypatch):
    original = {
        "running": True,
        "rows": [
            {
                "id": "other/model",
                "name": "Other",
                "context": 1048576,
                "historicallyVerified": False,
                "status": "unknown",
            },
            {
                "id": "anthropic/sonnet",
                "name": "Sonnet",
                "context": 1000000,
                "historicallyVerified": True,
                "status": "unknown",
            },
        ],
    }
    monkeypatch.setattr(service, "status", lambda: original)
    result = service.model_view({"verified": True})["rows"]
    assert len(result) == 1
    assert result[0]["name"] == "Sonnet"
    assert result[0]["contextLabel"] == "1 000 000"
    assert result[0]["statusLabel"] == "—"
    assert result[0]["hint"] == "Запись файлов подтверждена ранее"
    assert original["rows"][1]["status"] == "unknown"
    assert service.model_view({"verified": False})["rows"][0]["name"] == "Other"


def test_stopped_bridge_has_no_model_cards(monkeypatch):
    monkeypatch.setattr(service, "status", lambda: {"running": False, "rows": []})
    assert service.model_view({}) == {"rows": []}
