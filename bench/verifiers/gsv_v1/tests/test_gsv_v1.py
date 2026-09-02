import copy
import json
from types import SimpleNamespace

import pytest
import verifiers.v1 as vf

from gsv_v1 import GsvHarness, GsvTaskset, terminal_bench
from gsv_v1.evaluation import evaluate_predicate, evaluate_scenario, matches_subset
from gsv_v1.families import expand_family, load_scenarios
from gsv_v1.report import load_pricing, render_markdown, summarize_matrix
from gsv_v1.taskset import GsvConfig
from gsv_v1.terminal_bench import scenario_from_task


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
    taskset_config = vf.taskset_config_type("gsv-v1").model_validate({"id": "gsv-v1"})
    harness_config = vf.harness_config_type("gsv-v1").model_validate({"id": "gsv-v1"})
    taskset = vf.load_taskset(taskset_config)
    harness = vf.load_harness(harness_config)
    tasks = list(taskset)

    assert [task.key for task in tasks] == [
        "delegate-incident-from-slack",
        "deploy-release-across-targets",
        "recover-checkout-incident",
        "target-appears-after-inspection",
    ]
    assert tasks[3].data.scenario["components"]["transitions"][0]["after"] == {
        "processId": "ship",
        "tool": "Shell",
        "arguments": {
            "input": "targets list --json",
            "target": "gsv",
        },
        "outcome": "success",
    }
    assert (
        sum(milestone["weight"] for milestone in tasks[0].data.evaluation["milestones"])
        == 1.0
    )
    assert tasks[2].data.scenario["maxRuns"] == 3
    assert [
        event["id"] for event in tasks[2].data.scenario["components"]["events"]
    ] == ["checkout-health-window-1", "checkout-health-window-2"]
    assert isinstance(taskset, GsvTaskset)
    assert isinstance(harness, GsvHarness)


async def test_state_reward_is_offline_and_checks_nested_outcomes() -> None:
    task = next(
        task
        for task in GsvTaskset(GsvConfig(id="gsv-v1"))
        if task.key == "deploy-release-across-targets"
    )
    artifact = {
        "schemaVersion": 3,
        "scenarioId": task.data.scenario_id,
        "scenarioSeed": "deploy-release-across-targets-seed-001",
        "status": "yielded",
        "committedMessages": ["Deployment complete; release is live."],
        "world": {
            "targets": {
                "deploy-server": {"state": {"deployedRelease": "release-2026.09.01"}}
            },
            "processes": {
                "ship": {"visibleTargets": ["deploy-server", "build-laptop"]},
                "deploy-worker": {"visibleTargets": ["deploy-server"]},
            },
        },
        "log": [],
    }
    trace = make_trace(task)
    trace.info["gsv"] = artifact

    await task.score(trace)
    assert trace.reward == 1.0

    wrong_trace = make_trace(task)
    wrong_artifact = copy.deepcopy(artifact)
    wrong_artifact["world"]["targets"]["deploy-server"]["state"]["deployedRelease"] = (
        "wrong-release"
    )
    wrong_trace.info["gsv"] = wrong_artifact
    await task.score(wrong_trace)

    assert wrong_trace.reward == 0.4
    evaluation = wrong_trace.info["gsv_evaluation"]
    assert evaluation["raw_score"] == 0.4
    assert evaluation["strict_pass"] is False
    assert {
        milestone["id"]: milestone["passed"] for milestone in evaluation["milestones"]
    } == {"human-completion": True, "cross-target-outcome": False}


def test_evaluation_predicates_count_and_order_semantic_events() -> None:
    artifact: dict = {
        "log": [
            {"type": "run.started", "processId": "ship", "run": 1},
            {"type": "external.event", "id": "health-1"},
            {"type": "run.started", "processId": "ship", "run": 2},
            {"type": "external.event", "id": "health-2"},
            {
                "type": "responsibility.transition",
                "transition": {"kind": "resolved"},
            },
        ]
    }

    assert evaluate_predicate(
        artifact,
        {
            "type": "count",
            "path": "/log",
            "where": {"type": "run.started"},
            "min": 2,
        },
    )["passed"]
    assert evaluate_predicate(
        artifact,
        {
            "type": "order",
            "path": "/log",
            "before": {"type": "external.event", "id": "health-2"},
            "after": {
                "type": "responsibility.transition",
                "transition": {"kind": "resolved"},
            },
        },
    )["passed"]
    assert not evaluate_predicate(
        artifact,
        {
            "type": "count",
            "path": "/log",
            "where": {"type": "external.event"},
            "max": 1,
        },
    )["passed"]
    assert evaluate_predicate(
        artifact,
        {
            "type": "sequence",
            "path": "/log",
            "items": [
                {"type": "external.event", "id": "health-1"},
                {"type": "external.event", "id": "health-2"},
                {
                    "type": "responsibility.transition",
                    "transition": {"kind": "resolved"},
                },
            ],
        },
    )["passed"]
    assert not evaluate_predicate(
        artifact,
        {
            "type": "sequence",
            "path": "/log",
            "items": [
                {"type": "external.event", "id": "health-2"},
                {"type": "external.event", "id": "health-1"},
            ],
        },
    )["passed"]


def test_evaluator_tracks_dependencies_and_preserves_diagnostics_on_hard_failure() -> (
    None
):
    evaluation = {
        "milestones": [
            {
                "id": "outcome",
                "description": "The durable state is complete.",
                "dimension": "outcome",
                "weight": 0.75,
                "requires": [],
                "requiredForStrict": True,
                "predicates": [
                    {
                        "type": "match",
                        "path": "/world/state",
                        "value": {"done": True},
                    }
                ],
            },
            {
                "id": "communication",
                "description": "The user receives the result.",
                "dimension": "communication",
                "weight": 0.25,
                "requires": ["outcome"],
                "requiredForStrict": True,
                "predicates": [
                    {"type": "count", "path": "/committedMessages", "min": 1}
                ],
            },
        ],
        "constraints": [
            {
                "id": "no-bypass",
                "description": "Ship never bypasses the capability boundary.",
                "severity": "hard",
                "predicate": {
                    "type": "count",
                    "path": "/log",
                    "where": {"type": "forbidden"},
                    "max": 0,
                },
            }
        ],
    }
    result = evaluate_scenario(
        evaluation,
        {
            "world": {"state": {"done": True}},
            "committedMessages": [],
            "log": [{"type": "forbidden"}],
        },
    )

    assert result["raw_score"] == 0.75
    assert result["reward_score"] == 0.0
    assert result["strict_pass"] is False
    assert result["dimensions"]["outcome"]["score"] == 1.0
    assert result["dimensions"]["communication"]["score"] == 0.0
    assert matches_subset(
        [{"id": "second", "state": "done"}, {"id": "first", "state": "done"}],
        [{"id": "first"}, {"id": "second"}],
    )


def test_terminal_bench_task_becomes_a_special_target_scenario(tmp_path) -> None:
    task_dir = tmp_path / "write-file"
    (task_dir / "tests").mkdir(parents=True)
    (task_dir / "task.yaml").write_text(
        "instruction: Write hello to /app/result.txt\nparser_name: pytest\n"
    )
    (task_dir / "Dockerfile").write_text("FROM alpine:3.20\nWORKDIR /app\n")
    (task_dir / "run-tests.sh").write_text("#!/bin/sh\nexit 0\n")
    (task_dir / "tests" / "test_output.py").write_text("def test_output(): pass\n")

    scenario = scenario_from_task(task_dir)

    target = scenario["components"]["targets"][0]
    assert scenario["prompt"] == "Write hello to /app/result.txt"
    assert target["driver"] == "docker-exec"
    assert target["implements"] == ["shell.exec"]
    assert scenario["components"]["events"] == []
    assert scenario["evaluation"]["milestones"][0]["predicates"][0]["path"] == (
        "/external/terminalBench/reward"
    )


def test_terminal_bench_rejects_compose_semantics_it_cannot_preserve(tmp_path) -> None:
    task_dir = tmp_path / "multi-service"
    (task_dir / "tests").mkdir(parents=True)
    (task_dir / "task.yaml").write_text(
        "instruction: Repair the service\nparser_name: pytest\n"
    )
    (task_dir / "Dockerfile").write_text("FROM alpine:3.20\nWORKDIR /app\n")
    (task_dir / "run-tests.sh").write_text("#!/bin/sh\nexit 0\n")
    (task_dir / "tests" / "test_output.py").write_text("def test_output(): pass\n")
    (task_dir / "docker-compose.yaml").write_text(
        "services:\n  client:\n    build:\n      dockerfile: Dockerfile\n"
        "  database:\n    image: postgres:17\n"
    )

    with pytest.raises(ValueError, match="requires 2 compose services"):
        scenario_from_task(task_dir)


async def test_prime_sandbox_is_deleted_when_readiness_fails(
    tmp_path, monkeypatch
) -> None:
    task_dir = tmp_path / "prime-cleanup"
    task_dir.mkdir()
    commands: list[list[str]] = []

    class Runtime:
        async def run(self, command, _options):
            commands.append(command)
            if command[:4] == ["prime", "--plain", "sandbox", "create"]:
                return SimpleNamespace(
                    exit_code=0,
                    stdout="Successfully created sandbox sandbox-123",
                    stderr="",
                )
            return SimpleNamespace(exit_code=0, stdout="", stderr="")

    async def find_image(*_args):
        return "registry.example/image:tag"

    async def fail_readiness(*_args):
        raise RuntimeError("sandbox failed readiness")

    monkeypatch.setattr(terminal_bench, "find_prime_image", find_image)
    monkeypatch.setattr(terminal_bench, "wait_for_prime_sandbox", fail_readiness)

    with pytest.raises(RuntimeError, match="failed readiness"):
        await terminal_bench.start_prime_target(
            SimpleNamespace(id="trace-123456789"),
            Runtime(),
            task_dir,
            "a" * 64,
        )

    assert [
        "prime",
        "--plain",
        "sandbox",
        "delete",
        "--yes",
        "sandbox-123",
    ] in commands


def test_family_modules_compose_optional_targets_events_and_typed_values(
    tmp_path,
) -> None:
    family = {
        "familySchemaVersion": 1,
        "id": "composable",
        "tags": ["stateful"],
        "base": {
            "description": "Scenario ${variant_id}",
            "systemPrompt": "system",
            "prompt": "Handle ${service}",
            "entryProcessId": "ship",
            "world": {
                "runtime": {"now": "2026-09-02T00:00:00Z", "timezone": "UTC"},
                "processes": [],
                "delegates": [],
                "adapters": [],
            },
            "components": {"targets": [], "transitions": [], "events": []},
            "groundTruth": {"threshold": "${threshold}"},
            "evaluation": {"milestones": [], "constraints": []},
            "maxTurns": 10,
            "maxRuns": 1,
        },
        "modules": {
            "ship": {
                "world": {
                    "processes": [
                        {
                            "id": "ship",
                            "role": "ship",
                            "uid": 1000,
                            "gids": [1000],
                            "capabilities": [],
                        }
                    ]
                },
                "evaluation": {
                    "milestones": [
                        {
                            "id": "done",
                            "description": "done",
                            "dimension": "outcome",
                            "weight": 1,
                            "requires": [],
                            "requiredForStrict": True,
                            "predicates": [{"type": "count", "path": "/log", "min": 0}],
                        }
                    ]
                },
            },
            "browser": {
                "components": {
                    "targets": [
                        {
                            "id": "${service}-browser",
                            "kind": "browser",
                            "ownerUid": 1000,
                            "accessGids": [1000],
                            "online": True,
                        }
                    ]
                }
            },
            "scheduled": {
                "components": {
                    "events": [
                        {
                            "id": "wake",
                            "processId": "ship",
                            "delayMs": 1000,
                            "content": "wake",
                        }
                    ]
                },
                "maxRuns": 2,
            },
        },
        "variants": [
            {
                "id": "minimal",
                "seed": "seed-minimal",
                "modules": ["ship"],
                "values": {"service": "api", "threshold": 2},
            },
            {
                "id": "extended",
                "seed": "seed-extended",
                "modules": ["ship", "browser", "scheduled"],
                "values": {"service": "web", "threshold": 3},
                "tags": ["scheduled"],
            },
        ],
    }
    path = tmp_path / "family.json"
    path.write_text(json.dumps(family))

    scenarios = load_scenarios(path)

    assert [item["id"] for item in scenarios] == [
        "composable:minimal",
        "composable:extended",
    ]
    assert scenarios[0]["components"] == {
        "targets": [],
        "transitions": [],
        "events": [],
    }
    assert scenarios[0]["groundTruth"]["threshold"] == 2
    assert scenarios[1]["components"]["targets"][0]["id"] == "web-browser"
    assert scenarios[1]["components"]["events"][0]["id"] == "wake"
    assert scenarios[1]["maxRuns"] == 2
    assert scenarios[1]["tags"] == ["stateful", "scheduled"]


def test_family_expansion_rejects_unknown_modules_and_placeholders() -> None:
    base = {
        "familySchemaVersion": 1,
        "id": "broken",
        "base": {"prompt": "${missing}"},
        "modules": {},
        "variants": [{"id": "one", "seed": "seed", "modules": [], "values": {}}],
    }
    with pytest.raises(ValueError, match="Unknown placeholder"):
        expand_family(base, "inline")
    base["variants"][0]["modules"] = ["missing"]
    with pytest.raises(ValueError, match="unknown module"):
        expand_family(base, "inline")


def test_matrix_report_aggregates_quality_usage_and_pricing(tmp_path) -> None:
    run_dir = tmp_path / "qwen"
    run_dir.mkdir()
    envelopes = []
    for score, passed, duration in [
        (1.0, True, 10.0),
        (0.4, False, 20.0),
        (1.0, True, 30.0),
    ]:
        envelopes.append(
            {
                "ok": True,
                "errors": [],
                "traces": [
                    {
                        "ok": True,
                        "errors": [],
                        "agent": {"config": {"model": "qwen/example"}},
                        "rewards": {"scenario_outcome": {"score": score}},
                        "timing": {"agent": {"start": 10.0, "end": 10.0 + duration}},
                        "calls": [
                            {
                                "time": {"start": 1.0, "end": 5.0},
                                "usage": {
                                    "prompt_tokens": 1_000,
                                    "completion_tokens": 100,
                                    "cached_input_tokens": 500,
                                    "reasoning_tokens": 80,
                                },
                            }
                        ],
                        "info": {
                            "gsv": {"scenarioId": "scenario-a"},
                            "gsv_evaluation": {
                                "strict_pass": passed,
                                "raw_score": score,
                                "milestones": [
                                    {
                                        "id": "durable-outcome",
                                        "description": "The state is correct.",
                                        "dimension": "outcome",
                                        "passed": passed,
                                    }
                                ],
                                "dimensions": {
                                    "outcome": {"score": 1.0 if passed else 0.0}
                                },
                                "constraints": [],
                            },
                        },
                    }
                ],
            }
        )
    (run_dir / "traces.jsonl").write_text(
        "".join(json.dumps(envelope) + "\n" for envelope in envelopes)
    )
    legacy_run_dir = tmp_path / "legacy"
    legacy_run_dir.mkdir()
    (legacy_run_dir / "traces.jsonl").write_text(
        json.dumps(
            {
                "ok": True,
                "errors": [],
                "traces": [
                    {
                        "ok": True,
                        "errors": [],
                        "agent": {"config": {"model": "legacy/example"}},
                        "rewards": {"scenario_outcome": {"score": 0.8}},
                        "timing": {"agent": {"start": 1.0, "end": 3.0}},
                        "calls": [{"time": {"start": 1.0, "end": 2.0}}],
                        "info": {
                            "gsv": {"scenarioId": "scenario-a"},
                            "gsv_evaluation": {
                                "strict_pass": False,
                                "milestones": [],
                                "dimensions": {},
                                "constraints": [],
                            },
                        },
                    }
                ],
            }
        )
        + "\n"
    )
    pricing_path = tmp_path / "pricing.json"
    pricing_path.write_text(
        json.dumps(
            {
                "data": [
                    {
                        "id": "qwen/example",
                        "pricing": {
                            "input_usd_per_mtok": 1.0,
                            "output_usd_per_mtok": 2.0,
                        },
                    }
                ]
            }
        )
    )

    summary = summarize_matrix(tmp_path, load_pricing(pricing_path))
    model = next(
        model for model in summary["models"] if model["model"] == "qwen/example"
    )
    legacy = next(
        model for model in summary["models"] if model["model"] == "legacy/example"
    )

    assert model["model"] == "qwen/example"
    assert model["rollouts"] == 3
    assert model["score_mean"] == pytest.approx(0.8)
    assert model["raw_score_mean"] == pytest.approx(0.8)
    assert model["score_median"] == 1.0
    assert model["strict_passes"] == 2
    assert model["pass_at_1"] == 2 / 3
    assert model["pass_at_3"] == 1.0
    assert model["pass_power_3"] == 0.0
    assert model["calls_per_rollout"] == 1.0
    assert model["agent_seconds"] == 60.0
    assert model["wall_seconds"] == 30.0
    assert model["usage_coverage"] == 1.0
    assert model["input_tokens"] == 4_500
    assert model["completion_tokens"] == 300
    assert model["cached_input_rate"] == 1 / 3
    assert model["e2e_output_tokens_per_second"] == 5.0
    assert model["aggregate_output_tokens_per_second"] == 10.0
    assert model["request_output_tokens_per_second"] == 25.0
    assert model["listed_cost_usd"] == pytest.approx(0.0051)
    scenario_summary = model["scenarios"]["scenario-a"]
    assert scenario_summary["score_mean"] == pytest.approx(0.8)
    assert {
        key: value for key, value in scenario_summary.items() if key != "score_mean"
    } == {
        "rollouts": 3,
        "strict_passes": 2,
        "pass_at_1": 2 / 3,
        "pass_at_3": 1.0,
        "pass_power_3": 0.0,
    }
    assert model["milestones"]["durable-outcome"] == {
        "description": "The state is correct.",
        "dimension": "outcome",
        "passed": 2,
        "total": 3,
        "rate": 2 / 3,
    }
    assert model["dimensions"]["outcome"] == {
        "rollouts": 3,
        "score_mean": 2 / 3,
    }
    assert legacy["usage_coverage"] == 0.0
    assert legacy["input_tokens"] is None
    assert legacy["completion_tokens"] is None
    assert legacy["listed_cost_usd"] is None
    assert "qwen/example" in render_markdown(summary)
    assert "legacy/example" in render_markdown(summary)
    assert "n/a" in render_markdown(summary)
