"""Import the Harbor adapter when the package is installed."""

import importlib
import unittest


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


if __name__ == "__main__":
    unittest.main()
