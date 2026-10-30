import json
import os
import shutil
from pathlib import Path

from stitch_plugin_tools.publish import dev_install

package = Path(__file__).resolve().parents[1]
destination = dev_install(package, link=True)
data = destination.parent.parent / "data" / "plugins" / "stitch-velly"
data.mkdir(parents=True, exist_ok=True)
settings_path = data / "settings.json"
settings = (
    json.loads(settings_path.read_text(encoding="utf-8"))
    if settings_path.exists()
    else {}
)
roaming = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
settings.setdefault("profile", str(roaming / "Velly"))
node = shutil.which("node")
if node:
    settings.setdefault("node", node)
settings_path.write_text(
    json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8"
)
print(json.dumps({"plugin": str(destination), "data": str(data), "enabled": False}))
