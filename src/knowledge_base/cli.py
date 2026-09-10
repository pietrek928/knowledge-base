from __future__ import annotations

import argparse
import os


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="kb", description="Knowledge Base server")
    parser.add_argument("command", choices=["serve"], nargs="?", default="serve")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--config", default=None)
    parser.add_argument("--fake-ollama", action="store_true")
    args = parser.parse_args(argv)

    # Granian workers re-import the target; pass options via env so APP is built there.
    if args.fake_ollama:
        os.environ["KB_FAKE_OLLAMA"] = "1"
    if args.config:
        os.environ["KB_CONFIG"] = args.config

    from granian import Granian
    from granian.constants import Interfaces

    server = Granian(
        "knowledge_base._runtime:APP",
        address=args.host,
        port=args.port,
        interface=Interfaces.ASGI,
        workers=1,
    )
    server.serve()


if __name__ == "__main__":
    main()
