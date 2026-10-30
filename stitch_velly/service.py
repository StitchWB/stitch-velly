from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.request import ProxyHandler, Request, build_opener

_data_dir: Path | None = None
_process: subprocess.Popen | None = None
_lock = threading.RLock()
_action: dict[str, Any] | None = None
_startup_error: str | None = None
_autorestart_at = 0.0
_AUTORESTART_INTERVAL = 60.0


def configure(data_dir: str) -> None:
    global _data_dir, _startup_error
    if data_dir:
        _data_dir = Path(data_dir).resolve()
        _data_dir.mkdir(parents=True, exist_ok=True)
        if _read("lifecycle.json").get("enabled"):
            try:
                start()
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                _startup_error = (
                    "Bridge auto-start failed; check Node.js and port in settings"
                )


def health_check() -> dict:
    return {"pong": True}


def _directory() -> Path:
    if _data_dir is None:
        raise RuntimeError("Plugin data directory was not initialized")
    return _data_dir


def _read(name: str) -> dict:
    try:
        data = json.loads((_directory() / name).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(name: str, value: dict) -> None:
    path = _directory() / name
    temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _roaming() -> Path:
    if os.name == "nt":
        import ctypes

        value = ctypes.create_unicode_buffer(32768)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 0x1A, None, 0, value) == 0:
            return Path(value.value)
    return Path.home() / "AppData" / "Roaming"


def _shell_appdata() -> Path | None:
    if os.name != "nt":
        return None
    import winreg

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders",
        ) as key:
            value, _ = winreg.QueryValueEx(key, "AppData")
        return Path(value)
    except OSError:
        return None


def _has_velly_storage(profile: Path) -> bool:
    return (profile / "auth.bin").is_file() and (profile / "Local State").is_file()


def _velly_profile(settings: dict) -> Path:
    configured = Path(settings["profile"]).resolve()
    if _has_velly_storage(configured):
        return configured
    candidates = []
    shell = _shell_appdata()
    if shell:
        candidates.append((shell / "Velly").resolve())
    candidates.append((Path.home() / "AppData" / "Roaming" / "Velly").resolve())
    for candidate in candidates:
        if _has_velly_storage(candidate):
            return candidate
    return configured


def _node(settings: dict) -> str:
    override = settings.get("node") or os.environ.get("STITCH_VELLY_NODE")
    if override:
        candidate = Path(str(override))
        if candidate.is_absolute() and candidate.is_file():
            return str(candidate)
        raise ValueError("Node executable must be an existing absolute path")
    found = shutil.which("node")
    if found:
        return found
    bundled = _roaming() / "Velly" / "agent-tools" / "node" / "node.exe"
    if bundled.is_file():
        return str(bundled)
    for root in [
        os.environ.get("ProgramFiles", "C:/Program Files"),
        "C:/Program Files (x86)",
    ]:
        candidate = Path(root) / "nodejs" / "node.exe"
        if candidate.is_file():
            return str(candidate)
    raise RuntimeError("Node.js 22+ not found; set the node executable path")


def _settings(params: dict) -> dict:
    params = {k: v for k, v in params.items() if v != ""}
    settings = {**_read("settings.json"), **params}
    allowed = {
        "node",
        "profile",
        "port",
        "refreshMs",
        "chains",
        "outputLimit",
        "maxInFlight",
        "userAgent",
    }
    settings = {k: v for k, v in settings.items() if k in allowed}
    limits = [
        ("port", 38761, 1024, 65535),
        ("refreshMs", 600000, 60000, 86400000),
        ("outputLimit", 32000, 256, 128000),
        ("maxInFlight", 4, 1, 32),
    ]
    for key, default, low, high in limits:
        value = settings.get(key, default)
        if type(value) is not int or not low <= value <= high:
            raise ValueError(f"Invalid {key}: expected {low}..{high}")
        settings[key] = value
    settings["profile"] = str(
        Path(
            settings.get("profile")
            or os.environ.get("STITCH_VELLY_PROFILE")
            or _roaming() / "Velly"
        ).resolve()
    )
    chains = settings.get("chains")
    if chains is not None and (
        not isinstance(chains, dict)
        or any(
            not isinstance(k, str)
            or not isinstance(v, list)
            or not v
            or len(v) > 8
            or any(not isinstance(model, str) or not model for model in v)
            or len(set(v)) != len(v)
            for k, v in chains.items()
        )
    ):
        raise ValueError("chains must map names to 1..8 unique model IDs")
    if "userAgent" in settings and (
        not isinstance(settings["userAgent"], str)
        or not settings["userAgent"]
        or "\n" in settings["userAgent"]
        or "\r" in settings["userAgent"]
    ):
        raise ValueError("Invalid Claude user agent")
    return settings


def _control(path: str, body: dict | None = None) -> dict:
    if _process is None or _process.poll() is not None:
        raise RuntimeError("Velly bridge is stopped")
    base = _read("runtime.json").get("baseURL", "")
    if not base.startswith("http://127.0.0.1:") or not base.endswith("/v1"):
        raise RuntimeError("Invalid local bridge address")
    key = (_directory() / "local.key").read_text(encoding="utf-8").strip()
    request = Request(
        base[:-3] + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with build_opener(ProxyHandler({})).open(
        request, timeout=55 if path == "/control/probe" else 20
    ) as response:
        return json.load(response)


def start(params: dict | None = None) -> dict:
    global _process
    with _lock:
        if _process is not None and _process.poll() is None:
            return {"running": True, "alreadyRunning": True}
        settings = _settings(params or {})
        executable = _node(settings)
        version = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            text=True,
            check=False,
            timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if (
            version.returncode
            or int(version.stdout.strip().lstrip("v").split(".")[0]) < 22
        ):
            raise RuntimeError("Node.js 22+ is required")
        key_path = _directory() / "local.key"
        if not key_path.exists():
            fd = os.open(key_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as key_file:
                key_file.write(secrets.token_urlsafe(32))
        _write("settings.json", settings)
        _write("worker.json", {**settings, "dataDir": str(_directory())})
        (_directory() / "runtime.json").unlink(missing_ok=True)
        script = Path(__file__).parent / "runtime" / "worker.mjs"
        _process = subprocess.Popen(
            [executable, str(script), str(_directory() / "worker.json")],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if _process.poll() is not None:
                code = _process.returncode
                _process = None
                raise RuntimeError(
                    f"Bridge startup failed (exit {code}); check port and Node.js"
                )
            if (_directory() / "runtime.json").exists():
                _write("lifecycle.json", {"enabled": True})
                return {"running": True, "baseURL": _read("runtime.json")["baseURL"]}
            time.sleep(0.03)
        stop()
        raise RuntimeError("Bridge startup timed out")


def stop(*, disable: bool = True) -> dict:
    global _process
    with _lock:
        process, _process = _process, None
        if process is not None:
            if process.stdin:
                process.stdin.close()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        if _data_dir:
            (_data_dir / "runtime.json").unlink(missing_ok=True)
            if disable:
                _write("lifecycle.json", {"enabled": False})
    return {"running": False}


def status() -> dict:
    if _process is None or _process.poll() is not None:
        return {"running": False, "rows": [], "startupError": _startup_error}
    return _control("/control/status")


def summary() -> dict:
    state = status()
    if not state["running"]:
        return {
            "text": "**Мост остановлен.** Запустите его для подключения моделей. "
            + (state.get("startupError") or "")
        }
    updated = state.get("refreshedAt")
    try:
        updated = (
            datetime.fromisoformat(updated.replace("Z", "+00:00"))
            .astimezone()
            .strftime("%d.%m.%Y %H:%M")
            if updated
            else "ещё не получен"
        )
    except (ValueError, TypeError):
        updated = "дата неизвестна"
    text = f"**Мост работает** · {len(state['rows'])} модели · обновлено {updated}"
    if state.get("catalogError"):
        text += "\n\n" + state["catalogError"]
    selection = state.get("lastSelection")
    if selection:
        text += f"\n\nПоследний запрос: {selection['selected']} · HTTP {selection['httpStatus']}."
    return {"text": text}


def model_view(params: dict) -> dict:
    state = status()
    selected = params.get("verified")
    labels = {
        "unknown": "—",
        "healthy": "Последний запрос успешен",
        "cooldown": "Пауза после ошибки",
        "auth_failed": "Требуется вход в Velly",
        "unavailable": "Последний запрос отклонён",
        "request_error": "Ошибка последнего запроса",
    }
    rows = []
    for row in state.get("rows", []):
        verified = row.get("historicallyVerified") is True
        if type(selected) is bool and verified != selected:
            continue
        context = row.get("context")
        context_label = (
            f"{context:,}".replace(",", " ") if type(context) is int else "Не указан"
        )
        status_label = labels.get(row.get("status"), "Нет результата")
        rows.append(
            {
                "id": row["id"],
                "name": row.get("name") or row["id"],
                "contextLabel": context_label,
                "statusLabel": status_label,
                "subtitle": f"Контекст: {context_label} токенов",
                "body": status_label,
                "hint": "Запись файлов подтверждена ранее"
                if verified
                else "Инструменты ещё не проверены",
                "error": row.get("error") or "—",
                "tone": {
                    "healthy": "ok",
                    "cooldown": "warn",
                    "auth_failed": "down",
                    "unavailable": "down",
                }.get(row.get("status"), ""),
            }
        )
    return {"rows": rows}


def export_opencode(params: dict) -> dict:
    path = Path(
        params.get("path")
        or os.environ.get("STITCH_VELLY_OPENCODE_CONFIG")
        or _roaming().parents[1] / ".config" / "opencode" / "opencode.json"
    ).resolve()
    if path.name != "opencode.json" or not path.is_file():
        raise ValueError("Select an existing opencode.json")
    return _control("/control/export", {"path": str(path)})


def connection_info() -> dict:
    settings = _settings({})
    profile = _velly_profile(settings)
    return {
        "profile": str(profile),
        "node": _node(settings),
        "port": settings["port"],
        "opencodePath": os.environ.get("STITCH_VELLY_OPENCODE_CONFIG")
        or str(_roaming().parents[1] / ".config" / "opencode" / "opencode.json"),
        "exportsDirectory": str(_directory() / "exports"),
        "accessTokenPresent": (profile / "auth.bin").is_file(),
        "deviceKeyPresent": (profile / "secret-device-key.bin").is_file(),
    }


def export_secrets(params: dict) -> dict:
    include_device = params.get("includeDeviceKey", False)
    if type(include_device) is not bool:
        raise ValueError("includeDeviceKey must be boolean")
    settings = _settings({})
    script = Path(__file__).parent / "runtime" / "export-secrets.mjs"
    result = subprocess.run(
        [_node(settings), str(script)],
        check=False,
        input=json.dumps(
            {
                "profile": settings["profile"],
                "directory": str(_directory() / "exports"),
                "includeDeviceKey": include_device,
            }
        ),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        raise RuntimeError(
            "Не удалось экспортировать секреты. Проверьте профиль и вход в Velly."
        )
    data = json.loads(result.stdout)
    return {"path": data["path"], "fields": data["fields"]}


def _autorestart() -> None:
    global _autorestart_at, _startup_error
    if not _read("lifecycle.json").get("enabled"):
        return
    if time.monotonic() - _autorestart_at < _AUTORESTART_INTERVAL:
        return
    _autorestart_at = time.monotonic()
    try:
        start()
        _startup_error = None
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        _startup_error = f"Bridge auto-restart failed: {exc}"
        # провалившийся start() может погасить lifecycle через stop(); намерение юзера — включено
        _write("lifecycle.json", {"enabled": True})


def gateway_provider() -> dict:
    state = status()
    if not state["running"]:
        _autorestart()
        state = status()
        if not state["running"]:
            return {"running": False, "provider": {}, "runtime": []}
    provider = _control("/control/provider")
    groups: dict[str, dict] = {}
    for model_id, model in provider["models"].items():
        npm = model["provider"]["npm"]
        key = {
            "@ai-sdk/openai": "velly-responses",
            "@ai-sdk/anthropic": "velly-messages",
            "@ai-sdk/openai-compatible": "velly-chat",
        }[npm]
        protocol = key.removeprefix("velly-")
        options = {
            **provider["options"],
            "baseURL": provider["options"]["baseURL"].removesuffix("/v1")
            + f"/{protocol}/v1",
        }
        groups.setdefault(
            key, {"npm": npm, "name": key, "options": options, "models": {}}
        )
        groups[key]["models"][model_id] = model
    return {
        "running": True,
        "provider": groups,
        "runtime": state["rows"],
        "refreshedAt": state["refreshedAt"],
    }


def gateway_config() -> dict:
    bundle = gateway_provider()
    groups = bundle["provider"]
    path = _directory() / "gateway-opencode.json"
    _write(path.name, {"provider": groups})
    return {
        "path": str(path),
        "providers": list(groups),
        "models": sum(len(p["models"]) for p in groups.values()),
    }


def launch(command: str, params: dict | None = None) -> dict:
    global _action
    if command not in {"refresh_catalog", "probe_model"}:
        raise ValueError("Unknown background command")
    with _lock:
        if _action and _action["status"] == "running":
            return {"accepted": False, "reason": "Another plugin action is running"}
        action = {
            "id": uuid.uuid4().hex,
            "cmd": command,
            "status": "running",
            "startedAt": time.time(),
        }
        _action = action

    def run() -> None:
        try:
            result = _control(
                "/control/refresh"
                if command == "refresh_catalog"
                else "/control/probe",
                params or {},
            )
            with _lock:
                action.update(status="completed", result=result, finishedAt=time.time())
        except (OSError, ValueError, RuntimeError):
            with _lock:
                action.update(
                    status="failed",
                    error="Catalog refresh failed; check bridge status",
                    finishedAt=time.time(),
                )

    threading.Thread(target=run, daemon=True).start()
    return {"accepted": True, "actionId": action["id"]}


def action_status() -> dict:
    with _lock:
        return {
            "busy": bool(_action and _action["status"] == "running"),
            "recent": [dict(_action)] if _action else [],
        }
