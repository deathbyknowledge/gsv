import asyncio
import json
from pathlib import Path
from typing import Any, Literal

import verifiers.v1 as vf

from gsv_v1.evaluation import evaluate_scenario, validate_evaluation
from gsv_v1.families import load_scenarios
from gsv_v1.harness import ARTIFACT_PATH, SCENARIO_PATH
from gsv_v1.terminal_bench import (
    grade_terminal_bench,
    load_terminal_bench_scenarios,
    start_terminal_bench,
    stop_terminal_bench,
)

MAX_ARTIFACT_BYTES = 32 * 1024 * 1024


class GsvData(vf.TaskData):
    source: Literal["native", "terminal-bench"] = "native"
    scenario_id: str
    scenario: dict[str, Any]
    evaluation: dict[str, Any]
    terminal_task_dir: str | None = None
    terminal_backend: Literal["auto", "docker", "prime"] = "auto"


class GsvTask(vf.Task[GsvData]):
    @property
    def key(self) -> str:
        return self.data.scenario_id

    async def setup(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        if not isinstance(self.data.prompt, str):
            raise TypeError("GSV surface scenarios require a string prompt")
        scenario = {
            **self.data.scenario,
            "prompt": self.data.prompt,
            "systemPrompt": self.data.system_prompt,
        }
        if self.data.source == "terminal-bench":
            if self.data.terminal_task_dir is None:
                raise ValueError("Terminal-Bench task has no source directory")
            scenario = await start_terminal_bench(
                trace,
                runtime,
                scenario,
                Path(self.data.terminal_task_dir),
                self.data.terminal_backend,
            )
        try:
            await runtime.write(
                SCENARIO_PATH,
                json.dumps(scenario, sort_keys=True).encode(),
            )
        except (Exception, asyncio.CancelledError):
            if self.data.source == "terminal-bench":
                await stop_terminal_bench(trace, runtime)
            raise

    async def finalize(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        artifact_error: Exception | asyncio.CancelledError | None = None
        try:
            raw = await runtime.read(ARTIFACT_PATH, max_bytes=MAX_ARTIFACT_BYTES)
            artifact = json.loads(raw)
            if not isinstance(artifact, dict) or artifact.get("schemaVersion") != 3:
                raise ValueError("GSV runner returned an invalid artifact")
            if artifact.get("scenarioId") != self.data.scenario_id:
                raise ValueError("GSV runner artifact belongs to a different scenario")
            trace.info["gsv"] = artifact
            messages = artifact.get("committedMessages")
            if (
                isinstance(messages, list)
                and messages
                and isinstance(messages[-1], str)
            ):
                trace.root_reply = messages[-1]
        # Preserve any runtime/decoding failure while still owning target cleanup.
        except (Exception, asyncio.CancelledError) as error:  # noqa: BLE001
            artifact_error = error
        if self.data.source == "terminal-bench":
            if self.data.terminal_task_dir is None:
                raise ValueError("Terminal-Bench task has no source directory")
            try:
                result = await grade_terminal_bench(
                    trace, runtime, Path(self.data.terminal_task_dir)
                )
                trace.info["gsv_external"] = {"terminalBench": result}
            except (Exception, asyncio.CancelledError) as grader_error:
                if artifact_error is None:
                    raise
                artifact_error.add_note(
                    f"Terminal-Bench grading or cleanup also failed: {grader_error}"
                )
        if artifact_error is not None:
            raise artifact_error

    @vf.reward(weight=1.0)
    async def scenario_outcome(self, trace: vf.Trace) -> float:
        artifact = trace.info.get("gsv")
        if not isinstance(artifact, dict):
            return 0.0
        if (
            artifact.get("schemaVersion") != 3
            or artifact.get("scenarioId") != self.data.scenario_id
        ):
            return 0.0
        evaluation = evaluate_scenario(
            self.data.evaluation,
            artifact,
            trace.info.get("gsv_external"),
        )
        trace.info["gsv_evaluation"] = evaluation
        return float(evaluation["reward_score"])


class GsvConfig(vf.TasksetConfig):
    scenario_path: Path | None = None
    terminal_bench_path: Path | None = None
    terminal_tasks: list[str] | None = None
    terminal_backend: Literal["auto", "docker", "prime"] = "auto"


class GsvTaskset(vf.Taskset[GsvTask, GsvConfig]):
    def load(self) -> list[GsvTask]:
        if self.config.terminal_bench_path is not None:
            if self.config.scenario_path is not None:
                raise ValueError(
                    "scenario_path and terminal_bench_path are mutually exclusive"
                )
            return self._load_terminal_bench()
        configured = self.config.scenario_path or (
            Path(__file__).resolve().parent / "fixtures"
        )
        tasks: list[GsvTask] = []
        for idx, scenario in enumerate(load_scenarios(configured)):
            evaluation = validate_evaluation(
                scenario.get("evaluation"), f"scenario {scenario.get('id')}"
            )
            tasks.append(
                GsvTask(
                    GsvData(
                        idx=idx,
                        name=scenario["id"],
                        description=scenario["description"],
                        prompt=scenario["prompt"],
                        system_prompt=scenario["systemPrompt"],
                        scenario_id=scenario["id"],
                        scenario=scenario,
                        evaluation=evaluation,
                    ),
                    self.config.task,
                )
            )
        return tasks

    def _load_terminal_bench(self) -> list[GsvTask]:
        assert self.config.terminal_bench_path is not None
        tasks = []
        for idx, (scenario, task_dir) in enumerate(
            load_terminal_bench_scenarios(
                self.config.terminal_bench_path, self.config.terminal_tasks
            )
        ):
            evaluation = validate_evaluation(
                scenario["evaluation"], f"Terminal-Bench task {task_dir.name}"
            )
            tasks.append(
                GsvTask(
                    GsvData(
                        idx=idx,
                        name=scenario["id"],
                        description=scenario["description"],
                        prompt=scenario["prompt"],
                        system_prompt=scenario["systemPrompt"],
                        source="terminal-bench",
                        scenario_id=scenario["id"],
                        scenario=scenario,
                        evaluation=evaluation,
                        terminal_task_dir=str(task_dir),
                        terminal_backend=self.config.terminal_backend,
                    ),
                    self.config.task,
                )
            )
        return tasks
