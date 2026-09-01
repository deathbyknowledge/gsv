import json
from pathlib import Path
from typing import Any

import verifiers.v1 as vf

from gsv_v1.harness import ARTIFACT_PATH, SCENARIO_PATH

MAX_ARTIFACT_BYTES = 2 * 1024 * 1024


class GsvData(vf.TaskData):
    scenario_id: str
    scenario: dict[str, Any]
    expected_log: list[dict[str, Any]]


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
        if not isinstance(artifact, dict) or artifact.get("schemaVersion") != 1:
            raise ValueError("GSV runner returned an invalid artifact")
        if artifact.get("scenarioId") != self.data.scenario_id:
            raise ValueError("GSV runner artifact belongs to a different scenario")
        trace.info["gsv"] = artifact
        messages = artifact.get("committedMessages")
        if isinstance(messages, list) and messages and isinstance(messages[-1], str):
            trace.root_reply = messages[-1]

    @vf.reward(weight=1.0)
    async def exact_semantic_log(self, trace: vf.Trace) -> float:
        artifact = trace.info.get("gsv")
        if not isinstance(artifact, dict):
            return 0.0
        return float(
            artifact.get("status") == "yielded"
            and artifact.get("log") == self.data.expected_log
        )


class GsvConfig(vf.TasksetConfig):
    scenario_path: Path | None = None


class GsvTaskset(vf.Taskset[GsvTask, GsvConfig]):
    def load(self) -> list[GsvTask]:
        path = self.config.scenario_path or (
            Path(__file__).resolve().parent
            / "fixtures"
            / "target-appears-after-inspection.json"
        )
        scenario = json.loads(path.read_text())
        expected_log = scenario.get("expectedLog")
        if not isinstance(expected_log, list):
            raise TypeError(f"Scenario {path} has no expectedLog array")
        return [
            GsvTask(
                GsvData(
                    idx=0,
                    name=scenario["id"],
                    description=(
                        "Observe an ordered context-availability delta after a Shell inspection, "
                        "commit the requested message, and yield."
                    ),
                    prompt=scenario["prompt"],
                    system_prompt=scenario["systemPrompt"],
                    scenario_id=scenario["id"],
                    scenario=scenario,
                    expected_log=expected_log,
                ),
                self.config.task,
            )
        ]
