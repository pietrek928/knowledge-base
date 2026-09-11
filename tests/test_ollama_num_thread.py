"""OllamaClient num_thread defaults."""

import os
from unittest.mock import patch

from knowledge_base.ollama import OllamaClient, _default_num_thread


def test_default_num_thread_is_half_cpus():
    with patch("knowledge_base.ollama.os.cpu_count", return_value=12):
        assert _default_num_thread() == 6
    with patch("knowledge_base.ollama.os.cpu_count", return_value=1):
        assert _default_num_thread() == 1
    with patch("knowledge_base.ollama.os.cpu_count", return_value=None):
        assert _default_num_thread() == 1


def test_client_uses_config_and_model_num_thread():
    cfg = {"ollama": {"base_url": "http://127.0.0.1:9", "num_thread": 8}, "query_cache_size": 8}
    client = OllamaClient(cfg, [{"name": "m", "dim": 8}])
    assert client.num_thread == 8
    assert client.num_thread != _default_num_thread() or os.cpu_count() == 16
