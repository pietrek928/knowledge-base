"""Pytest defaults: never hit a live Ollama server."""

import os

# Must be set before any test creates an app without an explicit fake_ollama flag.
os.environ["KB_FAKE_OLLAMA"] = "1"
