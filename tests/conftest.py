"""Pytest defaults: never hit a live Ollama server."""

from __future__ import annotations

import os

# Must be set before any test creates an app without an explicit fake_ollama flag.
os.environ["KB_FAKE_OLLAMA"] = "1"
