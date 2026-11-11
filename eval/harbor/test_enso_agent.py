"""Import the Harbor adapter when the package is installed."""

import importlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


class EnsoAgentImportTest(unittest.TestCase):
    def test_adapter_subclasses_the_installed_agent_base(self) -> None:
        try:
            harbor = importlib.import_module("harbor.agents.installed.base")
        except ModuleNotFoundError:
            self.skipTest("harbor is not installed")
        module = importlib.import_module("eval.harbor.enso_agent")
        agent = module.EnsoCodeAgent
        self.assertTrue(issubclass(agent, harbor.BaseInstalledAgent))
        self.assertEqual(agent.name(), "enso-code")
        self.assertEqual(
            agent.import_path(),
            "eval.harbor.enso_agent:EnsoCodeAgent",
        )

    def test_usage_downloaded_after_run_still_reaches_the_context(self) -> None:
        try:
            context_module = importlib.import_module("harbor.models.agent.context")
        except ModuleNotFoundError:
            self.skipTest("harbor is not installed")
        import asyncio

        module = importlib.import_module("eval.harbor.enso_agent")
        with tempfile.TemporaryDirectory() as tmp:
            logs = Path(tmp)
            agent = module.EnsoCodeAgent(logs_dir=logs, model_name="openai/m")
            context = context_module.AgentContext()
            with (
                mock.patch.object(agent, "_upload_config_text", mock.AsyncMock()),
                mock.patch.object(
                    agent, "exec_as_agent", mock.AsyncMock(return_value=SimpleNamespace(stdout="out"))
                ),
            ):
                asyncio.run(agent.run("do it", mock.Mock(), context))
            # Harbor 只在 context 仍为空时调用 populate_context_post_run
            self.assertTrue(context.is_empty())
            (logs / "enso-usage.jsonl").write_text(
                json.dumps({"type": "summary", "inputTokens": 3, "outputTokens": 2, "calls": 1})
                + "\n",
                encoding="utf-8",
            )
            agent.populate_context_post_run(context)
            self.assertEqual(context.n_input_tokens, 3)
            self.assertEqual(context.n_output_tokens, 2)
            self.assertEqual(context.metadata, {"enso_stdout": "out"})


if __name__ == "__main__":
    unittest.main()
