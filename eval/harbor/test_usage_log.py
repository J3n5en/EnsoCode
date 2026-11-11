import json
import tempfile
import unittest
from pathlib import Path

from eval.harbor.command import api_kind, build_run_command, split_model_name
from eval.harbor.usage_log import parse_usage_log


class UsageLogTest(unittest.TestCase):
    def test_summary_wins_over_partial_calls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "usage.jsonl"
            path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "type": "call",
                                "model": "m",
                                "inputTokens": 1,
                                "outputTokens": 1,
                                "cacheReadTokens": 0,
                                "cacheWriteTokens": 0,
                                "costUsd": None,
                            }
                        ),
                        "not-json",
                        json.dumps(
                            {
                                "type": "summary",
                                "inputTokens": 9,
                                "outputTokens": 4,
                                "cacheReadTokens": 2,
                                "cacheWriteTokens": 1,
                                "costUsd": 0.5,
                                "calls": 3,
                            }
                        ),
                    ]
                ),
                encoding="utf-8",
            )
            parsed = parse_usage_log(path)
            assert parsed is not None
            self.assertEqual(parsed.input_including_cache, 12)
            self.assertEqual(parsed.cache_tokens, 3)
            self.assertEqual(parsed.output_tokens, 4)
            self.assertEqual(parsed.cost_usd, 0.5)
            self.assertEqual(parsed.calls, 3)

    def test_sums_calls_when_the_summary_was_not_flushed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "usage.jsonl"
            path.write_text(
                json.dumps(
                    {
                        "type": "call",
                        "model": "m",
                        "inputTokens": 2,
                        "outputTokens": 3,
                        "cacheReadTokens": 4,
                        "cacheWriteTokens": 0,
                        "costUsd": None,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            parsed = parse_usage_log(path)
            assert parsed is not None
            self.assertEqual(parsed.calls, 1)
            self.assertIsNone(parsed.cost_usd)
            self.assertEqual(parsed.by_model["m"].output_tokens, 3)
            self.assertIsNone(parse_usage_log(Path(tmp) / "missing.jsonl"))

    def test_command_quotes_the_prompt_path_and_splits_provider_models(self) -> None:
        self.assertEqual(split_model_name("openai/gpt-4o-mini"), "gpt-4o-mini")
        self.assertEqual(split_model_name("gpt-4o-mini"), "gpt-4o-mini")
        self.assertEqual(api_kind("anthropic-messages"), "anthropic-messages")
        self.assertEqual(api_kind("openai-responses"), "openai-responses")
        command = build_run_command(
            prompt_file="/logs/agent/instruction.md",
            usage_log="/logs/agent/enso-usage.jsonl",
            model="gpt-4o-mini",
            api="openai-completions",
            goal="ship it",
        )
        self.assertIn("enso-server run", command)
        self.assertIn("--prompt @/logs/agent/instruction.md", command.replace("'", ""))
        self.assertIn("--goal 'ship it'", command)


if __name__ == "__main__":
    unittest.main()
