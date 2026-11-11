"""Parse the JSONL written by ``enso-server run --usage-log``."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class UsageSummary:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost_usd: float | None = None
    calls: int = 0
    by_model: dict[str, "UsageSummary"] = field(default_factory=dict)

    @property
    def input_including_cache(self) -> int:
        return self.input_tokens + self.cache_read_tokens + self.cache_write_tokens

    @property
    def cache_tokens(self) -> int:
        return self.cache_read_tokens + self.cache_write_tokens


def _int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _cost(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _add(total: UsageSummary, record: dict[str, object], model: str | None) -> None:
    total.input_tokens += _int(record.get("inputTokens"))
    total.output_tokens += _int(record.get("outputTokens"))
    total.cache_read_tokens += _int(record.get("cacheReadTokens"))
    total.cache_write_tokens += _int(record.get("cacheWriteTokens"))
    cost = _cost(record.get("costUsd"))
    if cost is not None:
        total.cost_usd = (total.cost_usd or 0.0) + cost
    if model:
        bucket = total.by_model.setdefault(model, UsageSummary())
        _add(bucket, record, None)


def parse_usage_log(path: Path) -> UsageSummary | None:
    """Prefer the final summary line. Otherwise sum completed call lines."""
    if not path.is_file():
        return None
    summary: dict[str, object] | None = None
    calls: list[dict[str, object]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        if parsed.get("type") == "summary":
            summary = parsed
        elif parsed.get("type") == "call":
            calls.append(parsed)
    if summary is None and not calls:
        return None
    total = UsageSummary()
    if summary is not None:
        _add(total, summary, None)
        total.calls = _int(summary.get("calls")) or len(calls)
        return total
    for call in calls:
        model = call.get("model")
        _add(total, call, model if isinstance(model, str) and model else None)
        total.calls += 1
    return total
