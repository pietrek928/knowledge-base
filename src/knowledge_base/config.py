import json
import os
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_CONFIG = _ROOT / "config.json"


def expand_path(p: str | Path) -> Path:
    return Path(p).expanduser().resolve()


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    if path is None:
        env = os.environ.get("KB_CONFIG")
        path = env if env else _DEFAULT_CONFIG
    cfg_path = expand_path(path)
    data = json.loads(Path(cfg_path).read_text())
    data["data_dir"] = str(expand_path(data.get("data_dir", "~/.kb")))
    data["_config_path"] = str(cfg_path)
    return data


def model_slug(name: str) -> str:
    return name.replace("/", "__").replace(":", "__")
