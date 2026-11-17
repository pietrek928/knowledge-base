import logging
import os

import click


@click.group(invoke_without_command=True)
@click.pass_context
def main(ctx: click.Context) -> None:
    """Knowledge Base server."""
    if ctx.invoked_subcommand is None:
        ctx.invoke(serve)


@main.command("serve")
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", default=9099, show_default=True, type=int)
@click.option("--config", default=None, type=click.Path(exists=True, dir_okay=False))
@click.option("--fake-ollama", is_flag=True, help="Use fake embeddings (tests / no Ollama).")
@click.option(
    "--log-level",
    default="INFO",
    show_default=True,
    type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"], case_sensitive=False),
)
def serve(
    host: str, port: int, config: str | None, fake_ollama: bool, log_level: str
) -> None:
    """Run the knowledge base HTTP server."""
    if fake_ollama:
        os.environ["KB_FAKE_OLLAMA"] = "1"
    if config:
        os.environ["KB_CONFIG"] = config

    os.environ["KB_LOG_LEVEL"] = log_level.upper()
    logging.basicConfig(
        level=getattr(logging, log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%H:%M:%S",
        force=True,
    )

    from granian import Granian
    from granian.constants import Interfaces

    server = Granian(
        "knowledge_base._runtime:APP",
        address=host,
        port=port,
        interface=Interfaces.ASGI,
        workers=1,
    )
    server.serve()


if __name__ == "__main__":
    main()
