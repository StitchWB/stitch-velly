import asyncio
import json
import os
import tempfile
from pathlib import Path

from stitch_backend.domains.plugin_runtime.host import ServicePluginHost


async def main():
    package = Path(__file__).resolve().parents[1]
    local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    data = local / "stitch-manager" / "data" / "plugins" / "stitch-velly"
    host = ServicePluginHost(
        "stitch-velly-smoke",
        entry_module="stitch_velly",
        package_dir=package,
        data_dir=data,
        source="local",
    )
    result = {}
    try:
        assert (await host.start())["status"] == "running"
        result["start"] = await host.call("start_bridge", {})
        action = await host.call("refresh_catalog", {})
        assert action["accepted"]
        for _ in range(90):
            state = await host.call("action_status", {})
            if not state["busy"]:
                break
            await asyncio.sleep(0.25)
        assert not state["busy"]
        result["catalog"] = state["recent"][0]
        status = await host.call("get_status", {})
        assert status["refreshedAt"] and not status["catalogError"], status[
            "catalogError"
        ]
        result["models"] = [
            {
                "id": row["id"],
                "context": row["context"],
                "protocol": row["protocol"],
                "toolsPreviouslyVerified": row["historicallyVerified"],
            }
            for row in status["rows"]
        ]
        with tempfile.TemporaryDirectory(prefix="velly-opencode-smoke-") as temporary:
            config_path = Path(temporary) / "opencode.json"
            config_path.write_text(
                json.dumps({"model": "existing/model", "provider": {"existing": {}}}),
                encoding="utf-8",
            )
            exported = await host.call("export_opencode", {"path": str(config_path)})
            config = json.loads(config_path.read_text(encoding="utf-8"))
            assert (
                config["model"] == "existing/model" and "existing" in config["provider"]
            )
            result["exportedModelsIncludingAliases"] = exported["models"]
            result["protocols"] = sorted(
                {
                    m["provider"]["npm"]
                    for m in config["provider"]["velly"]["models"].values()
                }
            )
        result["gatewayExport"] = await host.call("export_gateway_config", {})
        result["generationRequests"] = 0
        result["workingOpenCodeConfigChanged"] = False
    finally:
        await host.stop()
    directory = package / "reports"
    directory.mkdir(exist_ok=True)
    (directory / "smoke.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "models": len(result["models"]),
                "exported": result["exportedModelsIncludingAliases"],
                "generations": 0,
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
