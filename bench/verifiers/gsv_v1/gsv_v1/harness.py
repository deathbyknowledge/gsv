import asyncio
import json
from pathlib import Path

import verifiers.v1 as vf

SCENARIO_PATH = "gsv-scenario.json"
ARTIFACT_PATH = "gsv-artifact.json"
PARTIAL_ARTIFACT_PATH = "gsv-partial-artifact.json"
MAX_PARTIAL_ARTIFACT_BYTES = 32 * 1024 * 1024


async def capture_partial_artifact(
    trace: vf.Trace,
    runtime: vf.Runtime,
    expected_scenario_id: str | None = None,
) -> None:
    try:
        raw = await runtime.read(
            PARTIAL_ARTIFACT_PATH,
            max_bytes=MAX_PARTIAL_ARTIFACT_BYTES,
        )
        artifact = json.loads(raw)
    # Diagnostics must never replace the original launch/finalization failure.
    except (Exception, asyncio.CancelledError):  # noqa: BLE001
        return
    if not isinstance(artifact, dict) or artifact.get("schemaVersion") != 1:
        return
    if (
        expected_scenario_id is not None
        and artifact.get("scenarioId") != expected_scenario_id
    ):
        return
    trace.info["gsv_partial"] = artifact


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


class GsvHarnessConfig(vf.HarnessConfig):
    repo_root: Path = default_repo_root()


class GsvHarness(vf.Harness[GsvHarnessConfig]):
    APPENDS_SYSTEM_PROMPT = True
    EXECUTES_CODE = False
    NEEDS_CONTAINER = False

    async def launch(
        self,
        ctx: vf.ModelContext,
        trace: vf.Trace,
        runtime: vf.Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
        data: vf.TaskData,
    ) -> vf.ProgramResult:
        if mcp_urls:
            raise ValueError("The GSV surface harness does not expose MCP servers")

        repo_root = self.config.repo_root.resolve()
        runner = repo_root / "bench" / "runtime" / "cli.ts"
        tsx = repo_root / "node_modules" / ".bin" / "tsx"
        if not runner.is_file() or not tsx.is_file():
            raise FileNotFoundError(
                "GSV runner or tsx is missing; use a GSV checkout with npm dependencies installed"
            )
        env = {
            **self.config.resolved_env,
            "GSV_BENCH_MODEL_ENDPOINT": endpoint,
            "GSV_BENCH_MODEL_SECRET": secret,
            "GSV_BENCH_MODEL": ctx.model,
        }
        try:
            return await runtime.run_program(
                [
                    str(tsx),
                    str(runner),
                    "--scenario",
                    SCENARIO_PATH,
                    "--artifact",
                    ARTIFACT_PATH,
                    "--partial-artifact",
                    PARTIAL_ARTIFACT_PATH,
                ],
                env,
            )
        except (Exception, asyncio.CancelledError):
            await capture_partial_artifact(
                trace,
                runtime,
                getattr(data, "scenario_id", None),
            )
            raise
