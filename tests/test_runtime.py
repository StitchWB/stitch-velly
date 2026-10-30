import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_node_runtime_contracts():
    node = shutil.which("node")
    if not node:
        pytest.fail("Node.js 22+ is required to test this plugin")
    result = subprocess.run(
        [node, "--test", *map(str, sorted((ROOT / "tests").glob("*.test.mjs")))],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
