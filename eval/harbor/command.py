"""Build the ``enso-server run`` argv without importing Harbor."""

from __future__ import annotations

import shlex


def split_model_name(model_name: str | None) -> str | None:
    if not model_name:
        return None
    text = model_name.strip()
    if not text or text.startswith("http://") or text.startswith("https://"):
        return text or None
    if "/" in text:
        return text.split("/", 1)[1] or None
    return text


def api_kind(model_api_format: str | None) -> str:
    text = (model_api_format or "").lower()
    if "anthropic" in text:
        return "anthropic-messages"
    if "response" in text:
        return "openai-responses"
    return "openai-completions"


def build_run_command(
    *,
    prompt_file: str,
    usage_log: str,
    model: str | None,
    api: str,
    mode: str = "full",
    cwd: str = ".",
    timeout_ms: int | None = None,
    goal: str | None = None,
    extra: list[str] | None = None,
) -> str:
    args = [
        "enso-server",
        "run",
        "--prompt",
        f"@{prompt_file}",
        "--cwd",
        cwd,
        "--mode",
        mode,
        "--api",
        api,
        "--output-format",
        "json",
        "--usage-log",
        usage_log,
    ]
    if model:
        args.extend(["--model", model])
    if timeout_ms is not None:
        args.extend(["--timeout-ms", str(timeout_ms)])
    if goal:
        args.extend(["--goal", goal])
    if extra:
        args.extend(extra)
    return " ".join(shlex.quote(part) for part in args)
