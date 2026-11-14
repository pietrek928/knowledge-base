"""ASGI target for Granian workers (must build the app on import)."""

import logging
import os

from knowledge_base.app import create_app
from knowledge_base.config import load_config

# Granian workers re-import this module; configure logging here so INFO reaches stderr.
logging.basicConfig(
    level=os.environ.get("KB_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
    force=True,
)

_cfg_path = os.environ.get("KB_CONFIG")
_fake = os.environ.get("KB_FAKE_OLLAMA", "").lower() in ("1", "true", "yes")
APP = create_app(load_config(_cfg_path) if _cfg_path else load_config(), fake_ollama=_fake)
