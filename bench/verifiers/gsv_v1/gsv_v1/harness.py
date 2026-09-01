from pathlib import Path

import verifiers.v1 as vf

SCENARIO_PATH = "gsv-scenario.json"
ARTIFACT_PATH = "gsv-artifact.json"


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
        del trace, data
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
        return await runtime.run_program(
            [
                str(tsx),
                str(runner),
                "--scenario",
                SCENARIO_PATH,
                "--artifact",
                ARTIFACT_PATH,
            ],
            env,
        )
