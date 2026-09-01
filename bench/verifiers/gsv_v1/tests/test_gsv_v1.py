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


def test_plugin_exports_and_loads_deterministic_tasks() -> None:
    taskset_config = vf.taskset_config_type("gsv-v1").model_validate(
        {"id": "gsv-v1"}
    )
    harness_config = vf.harness_config_type("gsv-v1").model_validate(
        {"id": "gsv-v1"}
    )
    taskset = vf.load_taskset(taskset_config)
    harness = vf.load_harness(harness_config)
    tasks = list(taskset)

    assert [task.key for task in tasks] == [
        "delegate-incident-from-slack",
        "deploy-release-across-targets",
        "target-appears-after-inspection",
    ]
    assert tasks[2].data.scenario["transitions"][0]["after"] == {
        "processId": "ship",
        "tool": "Shell",
        "arguments": {
            "input": "targets list --json",
            "target": "gsv",
        },
        "outcome": "success",
    }
    assert sum(
        criterion["weight"] for criterion in tasks[0].data.rubric
    ) == 1.0
    assert isinstance(taskset, GsvTaskset)
    assert isinstance(harness, GsvHarness)


async def test_state_reward_is_offline_and_checks_nested_outcomes() -> None:
    task = next(
        task
        for task in GsvTaskset(GsvConfig(id="gsv-v1"))
        if task.key == "deploy-release-across-targets"
    )
    artifact = {
        "schemaVersion": 2,
        "scenarioId": task.data.scenario_id,
        **copy.deepcopy(task.data.expected),
    }
    trace = make_trace(task)
    trace.info["gsv"] = artifact

    await task.score(trace)
    assert trace.reward == 1.0

    wrong_trace = make_trace(task)
    wrong_artifact = copy.deepcopy(artifact)
    wrong_artifact["world"]["targets"]["deploy-server"]["state"][
        "deployedRelease"
    ] = "wrong-release"
    wrong_trace.info["gsv"] = wrong_artifact
    await task.score(wrong_trace)

    assert wrong_trace.reward == 0.4
    assert wrong_trace.info["gsv_rubric"] == [
        {
            "id": "human-completion",
            "description": (
                "Ship commits the exact requested deployment confirmation "
                "and yields."
            ),
            "weight": 0.4,
            "passed": True,
        },
        {
            "id": "cross-target-outcome",
            "description": (
                "The release from the laptop is deployed on the server "
                "without broadening worker target access."
            ),
            "weight": 0.6,
            "passed": False,
        },
    ]
