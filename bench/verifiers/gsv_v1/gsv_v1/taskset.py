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
    rubric: list[dict[str, Any]]


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
        if (
            artifact.get("schemaVersion") != 2
            or artifact.get("scenarioId") != self.data.scenario_id
        ):
            return 0.0
        results = []
        earned = 0.0
        total = 0.0
        for criterion in self.data.rubric:
            weight = float(criterion["weight"])
            expected_passed = matches_expected(artifact, criterion["expected"])
            assertion_results = [
                {
                    "type": assertion["type"],
                    "passed": matches_assertion(artifact, assertion),
                }
                for assertion in criterion.get("assertions", [])
            ]
            passed = expected_passed and all(
                result["passed"] for result in assertion_results
            )
            total += weight
            if passed:
                earned += weight
            result = {
                "id": criterion["id"],
                "description": criterion["description"],
                "weight": weight,
                "passed": passed,
            }
            if assertion_results:
                result["assertions"] = assertion_results
            results.append(result)
        trace.info["gsv_rubric"] = results
        return earned / total if total > 0 else 0.0


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
            rubric = scenario.get("rubric")
            if not isinstance(rubric, list) or not rubric:
                raise TypeError(f"Scenario {path} has no rubric")
            for criterion in rubric:
                if (
                    not isinstance(criterion, dict)
                    or not isinstance(criterion.get("id"), str)
                    or not isinstance(criterion.get("description"), str)
                    or not isinstance(criterion.get("weight"), (int, float))
                    or criterion["weight"] <= 0
                    or not isinstance(criterion.get("expected"), dict)
                ):
                    raise TypeError(f"Scenario {path} has an invalid rubric criterion")
                validate_assertions(path, criterion.get("assertions", []))
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
                    rubric=rubric,
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


def validate_assertions(path: Path, assertions: object) -> None:
    if not isinstance(assertions, list):
        raise TypeError(f"Scenario {path} has invalid rubric assertions")
    for assertion in assertions:
        if not isinstance(assertion, dict):
            raise TypeError(f"Scenario {path} has an invalid rubric assertion")
        assertion_type = assertion.get("type")
        if assertion_type == "log_count":
            minimum = assertion.get("min")
            maximum = assertion.get("max")
            if (
                not isinstance(assertion.get("entry"), dict)
                or (minimum is None and maximum is None)
                or (minimum is not None and not is_nonnegative_int(minimum))
                or (maximum is not None and not is_nonnegative_int(maximum))
                or (
                    isinstance(minimum, int)
                    and isinstance(maximum, int)
                    and minimum > maximum
                )
            ):
                raise TypeError(f"Scenario {path} has an invalid log_count assertion")
            continue
        if assertion_type == "log_order":
            if not isinstance(assertion.get("before"), dict) or not isinstance(
                assertion.get("after"), dict
            ):
                raise TypeError(f"Scenario {path} has an invalid log_order assertion")
            continue
        raise TypeError(f"Scenario {path} has an unknown rubric assertion")


def matches_assertion(artifact: dict[str, Any], assertion: dict[str, Any]) -> bool:
    log = artifact.get("log")
    if not isinstance(log, list):
        return False
    assertion_type = assertion.get("type")
    if assertion_type == "log_count":
        count = sum(matches_expected(entry, assertion["entry"]) for entry in log)
        minimum = assertion.get("min")
        maximum = assertion.get("max")
        return (minimum is None or count >= minimum) and (
            maximum is None or count <= maximum
        )
    if assertion_type == "log_order":
        before = [
            index
            for index, entry in enumerate(log)
            if matches_expected(entry, assertion["before"])
        ]
        after = [
            index
            for index, entry in enumerate(log)
            if matches_expected(entry, assertion["after"])
        ]
        return any(left < right for left in before for right in after)
    return False


def is_nonnegative_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0
