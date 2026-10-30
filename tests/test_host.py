import shutil
import socket
from pathlib import Path

import pytest

host_module = pytest.importorskip("stitch_backend.domains.plugin_runtime.host")
ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.asyncio
async def test_host_starts_bridge_and_resumes_it_after_host_restart(tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    kwargs = {
        "entry_module": "stitch_velly",
        "package_dir": ROOT,
        "data_dir": tmp_path / "data",
        "source": "local",
        "env": {"STITCH_VELLY_NODE": shutil.which("node")},
    }
    host = host_module.ServicePluginHost("stitch-velly-test", **kwargs)
    try:
        assert (await host.start())["status"] == "running"
        assert await host.ping()
        started = await host.call(
            "start_bridge", {"profile": str(tmp_path / "missing-profile"), "port": port}
        )
        assert started["running"]
        status = await host.call("get_status", {})
        assert status["running"] and status["rows"] == []
        assert "apiKey" not in status
    finally:
        await host.stop()
    assert not (tmp_path / "data" / "runtime.json").exists()
    resumed = host_module.ServicePluginHost("stitch-velly-test", **kwargs)
    try:
        assert (await resumed.start())["status"] == "running"
        assert (await resumed.call("get_status", {}))["running"]
        assert (await resumed.call("stop_bridge", {}))["running"] is False
    finally:
        await resumed.stop()
