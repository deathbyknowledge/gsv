import copy

import verifiers.v1 as vf

from gsv_v1 import GsvHarness, GsvTaskset
from gsv_v1.taskset import GsvConfig


def make_trace(task) -> vf.Trace:
    return vf.Trace(
        agent=vf.AgentInfo(config=vf.AgentConfig()),
        task=vf.TraceTask(
            type=type(task).__name__,
            data=task.data,
            key=task.key,
            hash=task.hash,
        ),
    )


def test_plugin_exports_and_loads_one_deterministic_task() -> None:
    taskset_config = vf.taskset_config_type("gsv-v1").model_validate(
        {"id": "gsv-v1"}
    )
    harness_config = vf.harness_config_type("gsv-v1").model_validate(
        {"id": "gsv-v1"}
    )
    taskset = vf.load_taskset(taskset_config)
    harness = vf.load_harness(harness_config)
    (task,) = list(taskset)

    assert task.key == "target-appears-after-inspection"
    assert task.data.scenario["transition"]["trigger"] == {
        "tool": "Shell",
        "input": "targets list",
    }
    assert isinstance(taskset, GsvTaskset)
    assert isinstance(harness, GsvHarness)


async def test_exact_semantic_reward_is_offline_and_strict() -> None:
    (task,) = list(GsvTaskset(GsvConfig(id="gsv-v1")))
    artifact = {
        "schemaVersion": 1,
        "scenarioId": task.data.scenario_id,
        "status": "yielded",
        "log": copy.deepcopy(task.data.expected_log),
    }
    trace = make_trace(task)
    trace.info["gsv"] = artifact

    await task.score(trace)
    assert trace.reward == 1.0

    wrong_trace = make_trace(task)
    wrong_artifact = copy.deepcopy(artifact)
    wrong_artifact["log"][0]["input"] = "targets status"
    wrong_trace.info["gsv"] = wrong_artifact
    await task.score(wrong_trace)

    assert wrong_trace.reward == 0.0
