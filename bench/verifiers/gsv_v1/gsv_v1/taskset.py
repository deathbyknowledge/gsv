import json
from pathlib import Path
from typing import Any

import verifiers.v1 as vf

from gsv_v1.harness import ARTIFACT_PATH, SCENARIO_PATH

MAX_ARTIFACT_BYTES = 2 * 1024 * 1024


class GsvData(vf.TaskData):
    scenario_id: str
    scenario: dict[str, Any]
    expected: dict[str, Any]


class GsvTask(vf.Task[GsvData]):
    @property
    def key(self) -> str:
        return self.data.scenario_id

    async def setup(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        del trace
        if not isinstance(self.data.prompt, str):
            raise TypeError("GSV surface scenarios require a string prompt")
        scenario = {
            **self.data.scenario,
            "prompt": self.data.prompt,
            "systemPrompt": self.data.system_prompt,
        }
        await runtime.write(
            SCENARIO_PATH,
            json.dumps(scenario, sort_keys=True).encode(),
        )

    async def finalize(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        raw = await runtime.read(ARTIFACT_PATH, max_bytes=MAX_ARTIFACT_BYTES)
        artifact = json.loads(raw)
        if not isinstance(artifact, dict) or artifact.get("schemaVersion") != 2:
            raise ValueError("GSV runner returned an invalid artifact")
        if artifact.get("scenarioId") != self.data.scenario_id:
            raise ValueError("GSV runner artifact belongs to a different scenario")
        trace.info["gsv"] = artifact
        messages = artifact.get("committedMessages")
        if isinstance(messages, list) and messages and isinstance(messages[-1], str):
            trace.root_reply = messages[-1]

    @vf.reward(weight=1.0)
    async def scenario_outcome(self, trace: vf.Trace) -> float:
        artifact = trace.info.get("gsv")
        if not isinstance(artifact, dict):
            return 0.0
        return float(
            artifact.get("schemaVersion") == 2
            and artifact.get("scenarioId") == self.data.scenario_id
            and matches_expected(artifact, self.data.expected)
        )


class GsvConfig(vf.TasksetConfig):
    scenario_path: Path | None = None


class GsvTaskset(vf.Taskset[GsvTask, GsvConfig]):
    def load(self) -> list[GsvTask]:
        configured = self.config.scenario_path or (
            Path(__file__).resolve().parent
            / "fixtures"
        )
        paths = (
            sorted(configured.glob("*.json"))
            if configured.is_dir()
            else [configured]
        )
        if not paths:
            raise ValueError(f"No GSV scenarios found at {configured}")
        tasks: list[GsvTask] = []
        for idx, path in enumerate(paths):
            scenario = json.loads(path.read_text())
            if scenario.get("schemaVersion") != 2:
                raise ValueError(f"Scenario {path} does not use schemaVersion 2")
            expected = scenario.get("expected")
            if not isinstance(expected, dict):
                raise TypeError(f"Scenario {path} has no expected object")
            tasks.append(GsvTask(
                GsvData(
                    idx=idx,
                    name=scenario["id"],
                    description=scenario["description"],
                    prompt=scenario["prompt"],
                    system_prompt=scenario["systemPrompt"],
                    scenario_id=scenario["id"],
                    scenario=scenario,
                    expected=expected,
                ),
                self.config.task,
            ))
        return tasks


def matches_expected(actual: object, expected: object) -> bool:
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and matches_expected(actual[key], value)
            for key, value in expected.items()
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(
                matches_expected(actual_item, expected_item)
                for actual_item, expected_item in zip(actual, expected, strict=True)
            )
        )
    return actual == expected
