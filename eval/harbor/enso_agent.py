"""Harbor installed-agent adapter for ``enso-server run``.

    harbor run ... --agent-import-path eval.harbor.enso_agent:EnsoCodeAgent -m <model>
"""

from __future__ import annotations

import os
import shlex
from pathlib import Path

from harbor.agents.agent_auth_resolution import ModelConnectionSpec, ProviderAccess
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.model_api_format import ModelApiFormat

from eval.harbor.command import api_kind, build_run_command, split_model_name
from eval.harbor.usage_log import parse_usage_log


class EnsoCodeAgent(BaseInstalledAgent):
    """Run EnsoCode headlessly inside a Harbor environment."""

    capabilities = AgentCapabilities(base_url=True)
    MODEL_CONNECTION = ModelConnectionSpec(
        default_provider="openai",
        agent_provider_access=ProviderAccess(
            api_key_candidate_names=["ENSO_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
            base_url_candidate_names=["ENSO_BASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"],
        ),
        api_key_destination_names={
            "default": "ENSO_API_KEY",
            "openai": "ENSO_API_KEY",
            "anthropic": "ENSO_API_KEY",
        },
        base_url_destination_names={
            "default": "ENSO_BASE_URL",
            "openai": "ENSO_BASE_URL",
            "anthropic": "ENSO_BASE_URL",
        },
        supported_api_formats=[
            ModelApiFormat.OPENAI_CHAT_COMPLETIONS,
            ModelApiFormat.OPENAI_RESPONSES,
            ModelApiFormat.ANTHROPIC_MESSAGES,
        ],
        default_api_format_by_provider={"default": ModelApiFormat.OPENAI_CHAT_COMPLETIONS},
    )

    @staticmethod
    def name() -> str:  # type: ignore[override]
        return "enso-code"

    def version(self) -> str | None:
        return os.environ.get("ENSO_VERSION")

    def _package(self) -> Path | None:
        raw = self._model_connection_kwargs.get("package") or os.environ.get("ENSO_SERVER_TARBALL")
        if not isinstance(raw, str) or not raw.strip():
            return None
        path = Path(raw).expanduser()
        return path if path.is_file() else None

    async def install(self, environment: BaseEnvironment) -> None:
        script = Path(__file__).with_name("install.sh")
        await environment.upload_file(script, "/tmp/enso-install.sh")
        package = self._package()
        remote_package = ""
        if package is not None:
            await environment.upload_file(package, "/tmp/ensocode-server.tgz")
            remote_package = "/tmp/ensocode-server.tgz"
        # @vscode/ripgrep 的 postinstall 走 GitHub API 下载，未鉴权时每个出口 IP 每小时 60 次，批量跑很快 403
        token = os.environ.get("GITHUB_TOKEN")
        await self.exec_as_root(
            environment,
            command=f"bash /tmp/enso-install.sh {shlex.quote(remote_package)}".rstrip(),
            env={"GITHUB_TOKEN": token} if token else None,
            timeout_sec=600,
        )

    def _connection_env(self) -> dict[str, str]:
        env = dict(self._extra_env)
        connection = self.model_connection
        if connection.api_key:
            env["ENSO_API_KEY"] = connection.api_key
        base_url = connection.execution_base_url or connection.user_supplied_base_url
        if base_url:
            env["ENSO_BASE_URL"] = base_url
        return env

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        logs = str(self.environment_logs_dir)
        prompt_file = f"{logs}/instruction.md"
        usage_log = f"{logs}/enso-usage.jsonl"
        await self._upload_config_text(
            environment,
            content=instruction,
            remote_path=prompt_file,
            filename="instruction.md",
        )
        goal = self._model_connection_kwargs.get("goal")
        timeout = self._model_connection_kwargs.get("timeout_ms")
        mode = self._model_connection_kwargs.get("mode")
        command = build_run_command(
            prompt_file=prompt_file,
            usage_log=usage_log,
            model=split_model_name(self.model_name),
            api=api_kind(
                str(self.model_connection.model_api_format)
                if self.model_connection.model_api_format
                else None
            ),
            mode=mode if isinstance(mode, str) and mode else "full",
            timeout_ms=timeout if isinstance(timeout, int) else None,
            goal=goal if isinstance(goal, str) and goal else None,
        )
        try:
            result = await self.exec_as_agent(environment, command=command, env=self._connection_env())
            self._stdout = getattr(result, "stdout", None)
        finally:
            # 日志目录未挂载时此刻还没下载回来；context 一旦非空 Harbor 就不再调 populate_context_post_run
            self._apply_usage(context)

    def populate_context_post_run(self, context: AgentContext) -> None:
        self._apply_usage(context, final=True)

    def _apply_usage(self, context: AgentContext, final: bool = False) -> None:
        parsed = parse_usage_log(self.logs_dir / "enso-usage.jsonl")
        if parsed is None and not final:
            return
        stdout = getattr(self, "_stdout", None)
        if stdout:
            context.metadata = {**(context.metadata or {}), "enso_stdout": stdout}
        if parsed is None:
            return
        context.n_input_tokens = parsed.input_including_cache
        context.n_cache_tokens = parsed.cache_tokens
        context.n_output_tokens = parsed.output_tokens
        if parsed.cost_usd is not None:
            context.cost_usd = parsed.cost_usd
        if parsed.by_model:
            from harbor.models.agent.context import ModelUsage

            context.model_usage = {
                model: ModelUsage(
                    n_input_tokens=item.input_including_cache,
                    n_cache_tokens=item.cache_tokens,
                    n_output_tokens=item.output_tokens,
                    cost_usd=item.cost_usd,
                )
                for model, item in parsed.by_model.items()
            }
