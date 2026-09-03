import copy
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest
import verifiers.v1 as vf

from gsv_v1 import GsvHarness, GsvTaskset, terminal_bench
from gsv_v1.evaluation import evaluate_predicate, evaluate_scenario, matches_subset
from gsv_v1.families import expand_family, load_scenarios
from gsv_v1.harness import PARTIAL_ARTIFACT_PATH, capture_partial_artifact
from gsv_v1.report import (
    load_evaluations,
    load_pricing,
    render_markdown,
    summarize_matrix,
)
from gsv_v1.taskset import MAX_ARTIFACT_BYTES, GsvConfig
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


async def test_finalize_accepts_artifacts_larger_than_one_command_output() -> None:
    task = next(
        task
        for task in GsvTaskset(GsvConfig(id="gsv-v1"))
        if task.key == "deploy-release-across-targets"
    )
    artifact = {
        "schemaVersion": 3,
        "scenarioId": task.data.scenario_id,
        "committedMessages": [],
        "capturedOutput": "x" * (4 * 1024 * 1024),
    }
    payload = json.dumps(artifact).encode()

    class Runtime:
        async def read(self, path, *, max_bytes):
            assert path == "gsv-artifact.json"
            assert len(payload) < max_bytes == MAX_ARTIFACT_BYTES
            return payload

    trace = make_trace(task)
    await task.finalize(trace, Runtime())

    assert trace.info["gsv"]["capturedOutput"] == artifact["capturedOutput"]


async def test_captures_valid_partial_artifact_for_timeout_diagnostics() -> None:
    partial = {
        "schemaVersion": 1,
        "scenarioId": "stateful-timeout",
        "phase": "model.request",
        "activeProcessId": "ship",
        "run": 2,
        "turn": 7,
        "log": [{"type": "run.started", "processId": "ship", "run": 2}],
    }

    class Runtime:
        async def read(self, path, *, max_bytes):
            assert path == PARTIAL_ARTIFACT_PATH
            assert max_bytes == 32 * 1024 * 1024
            return json.dumps(partial).encode()

    trace = SimpleNamespace(info={})
    await capture_partial_artifact(trace, Runtime(), "stateful-timeout")

    assert trace.info["gsv_partial"] == partial


async def test_ignores_partial_artifact_from_another_scenario() -> None:
    class Runtime:
        async def read(self, path, *, max_bytes):
            del path, max_bytes
            return json.dumps(
                {"schemaVersion": 1, "scenarioId": "another-scenario"}
            ).encode()

    trace = SimpleNamespace(info={})
    await capture_partial_artifact(trace, Runtime(), "expected-scenario")

    assert trace.info == {}


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
    assert result["earned_weight"] == 0.75
    assert result["total_weight"] == 1.0
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


@pytest.mark.parametrize(
    ("option", "name"),
    [
        ("    command: ['sleep', 'infinity']\n", "command"),
        ("    environment:\n      MODE: test\n", "environment"),
        ("    image: example/service:latest\n", "image"),
        ("    volumes:\n      - ./data:/data\n", "volumes"),
    ],
)
def test_terminal_bench_rejects_ignored_service_options(
    tmp_path, option, name
) -> None:
    task_dir = tmp_path / name
    task_dir.mkdir()
    (task_dir / "task.yaml").write_text(
        "instruction: Repair the service\nparser_name: pytest\n"
    )
    (task_dir / "Dockerfile").write_text("FROM alpine:3.20\nWORKDIR /app\n")
    (task_dir / "run-tests.sh").write_text("#!/bin/sh\nexit 0\n")
    (task_dir / "tests").mkdir()
    (task_dir / "docker-compose.yaml").write_text(
        "services:\n  client:\n    build: .\n" + option
    )

    with pytest.raises(ValueError, match=f"unsupported compose options: {name}"):
        scenario_from_task(task_dir)


def test_terminal_bench_rejects_ignored_build_options(tmp_path) -> None:
    task_dir = tmp_path / "build-args"
    task_dir.mkdir()
    (task_dir / "task.yaml").write_text(
        "instruction: Repair the service\nparser_name: pytest\n"
    )
    (task_dir / "Dockerfile").write_text("FROM alpine:3.20\nWORKDIR /app\n")
    (task_dir / "run-tests.sh").write_text("#!/bin/sh\nexit 0\n")
    (task_dir / "tests").mkdir()
    (task_dir / "docker-compose.yaml").write_text(
        "services:\n  client:\n    build:\n      context: .\n"
        "      args:\n        MODE: test\n"
    )

    with pytest.raises(ValueError, match="unsupported compose build options: args"):
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


def test_release_recovery_communication_allows_progress_updates() -> None:
    family_path = (
        Path(__file__).resolve().parents[1]
        / "gsv_v1"
        / "families"
        / "release-recovery.json"
    )
    scenario = load_scenarios(family_path)[0]
    communication = next(
        milestone
        for milestone in scenario["evaluation"]["milestones"]
        if milestone["id"] == "incident-communication"
    )
    message_count = next(
        predicate
        for predicate in communication["predicates"]
        if predicate.get("path") == "/committedMessages"
    )

    assert message_count == {
        "type": "count",
        "path": "/committedMessages",
        "min": 2,
    }
    assert load_evaluations(family_path)[scenario["id"]] == scenario["evaluation"]


def test_competing_incident_family_has_seeded_topology_diversity() -> None:
    family_path = (
        Path(__file__).resolve().parents[1]
        / "gsv_v1"
        / "families"
        / "competing-incidents.json"
    )
    scenarios = load_scenarios(family_path)

    assert len(scenarios) == 10
    assert len({scenario["id"] for scenario in scenarios}) == 10
    assert len({scenario["seed"] for scenario in scenarios}) == 10
    assert all(scenario["family"] == "competing-incidents" for scenario in scenarios)
    assert all(len(scenario["components"]["events"]) == 2 for scenario in scenarios)
    assert all(len(scenario["world"]["delegates"]) == 3 for scenario in scenarios)
    target_sets = [
        {target["id"] for target in scenario["components"]["targets"]}
        for scenario in scenarios
    ]
    assert any("shared-dependency-diagnostics" in targets for targets in target_sets)
    assert any("shared-dependency-diagnostics" not in targets for targets in target_sets)
    assert any(any(target.endswith("-approval") for target in targets) for targets in target_sets)
    assert any(
        not any(target.endswith("-approval") for target in targets)
        for targets in target_sets
    )
    assert any(
        not next(
            target
            for target in scenario["components"]["targets"]
            if target["id"]
            == f"{scenario['groundTruth']['priorityService']}-control"
        )["online"]
        for scenario in scenarios
    )


def test_service_account_family_covers_authorized_and_withheld_outcomes() -> None:
    family_path = (
        Path(__file__).resolve().parents[1]
        / "gsv_v1"
        / "families"
        / "service-account-operation.json"
    )
    scenarios = load_scenarios(family_path)
    dispositions = [scenario["groundTruth"]["disposition"] for scenario in scenarios]

    assert len(scenarios) == 10
    assert len({scenario["id"] for scenario in scenarios}) == 10
    assert len({scenario["seed"] for scenario in scenarios}) == 10
    assert dispositions.count("approved") == 7
    assert dispositions.count("denied") == 2
    assert dispositions.count("expired") == 1
    assert all(
        scenario["family"] == "service-account-operation"
        for scenario in scenarios
    )
    assert all(len(scenario["world"]["delegates"]) == 2 for scenario in scenarios)
    assert all(
        1000
        not in next(
            target
            for target in scenario["components"]["targets"]
            if target["id"] == "slack-service-account"
        )["accessGids"]
        for scenario in scenarios
    )
    assert {
        len(scenario["components"]["events"])
        for scenario in scenarios
    } == {1, 2}
    optional_target_counts = {
        sum(
            target["id"]
            in {"security-ticket-system", "contract-browser", "manager-directory"}
            for target in scenario["components"]["targets"]
        )
        for scenario in scenarios
    }
    assert optional_target_counts == {0, 1, 2, 3}


def test_stateful_outcome_rubrics_do_not_require_one_resolution_vocabulary() -> None:
    families = (
        Path(__file__).resolve().parents[1] / "gsv_v1" / "families"
    )
    service_scenarios = load_scenarios(
        families / "service-account-operation.json"
    )
    approved = next(
        scenario
        for scenario in service_scenarios
        if scenario["groundTruth"]["disposition"] == "approved"
    )
    denied = next(
        scenario
        for scenario in service_scenarios
        if scenario["groundTruth"]["disposition"] == "denied"
    )
    competing = load_scenarios(families / "competing-incidents.json")[0]

    checks = [
        (
            approved,
            "membership-confirmed-and-resolved",
            "request",
            {
                "state": "resolved",
                "assignee": {"kind": "ship"},
                "resolution": {
                    "disposition": "approved_and_confirmed",
                    "request_id": approved["groundTruth"]["requestId"],
                },
            },
        ),
        (
            denied,
            "non-approved-request-cancelled",
            "request",
            {
                "state": "cancelled",
                "assignee": {"kind": "ship"},
                "resolution": {
                    "outcome": "access_withheld",
                    "request_id": denied["groundTruth"]["requestId"],
                },
            },
        ),
        (
            competing,
            "priority-inversion-reconciled",
            "initial",
            {
                "state": "cancelled",
                "priority": "low",
                "resolution": {"reason": "superseded by the priority incident"},
            },
        ),
    ]
    for scenario, milestone_id, reference, responsibility in checks:
        milestone = next(
            item
            for item in scenario["evaluation"]["milestones"]
            if item["id"] == milestone_id
        )
        predicate = next(
            item
            for item in milestone["predicates"]
            if item.get("path", "").startswith(
                "/world/responsibilities/references/"
            )
        )
        assert "resolution" not in predicate["value"]
        artifact = {
            "world": {
                "responsibilities": {
                    "references": {reference: responsibility}
                }
            }
        }
        assert evaluate_predicate(artifact, predicate)["passed"]


def test_competing_incident_acknowledgement_scores_before_priority_event() -> None:
    family = (
        Path(__file__).resolve().parents[1]
        / "gsv_v1"
        / "families"
        / "competing-incidents.json"
    )
    scenario = load_scenarios(family)[0]
    milestone = next(
        item
        for item in scenario["evaluation"]["milestones"]
        if item["id"] == "initial-acknowledgement-and-ownership"
    )
    sequence = next(
        predicate
        for predicate in milestone["predicates"]
        if predicate["type"] == "sequence"
    )

    assert [item["type"] for item in sequence["items"]] == [
        "responsibility.transition",
        "responsibility.transition",
    ]
    priority_event = next(
        event
        for event in scenario["components"]["events"]
        if event["id"].endswith("-priority-inversion")
    )
    assert "to low priority" in priority_event["content"]
    assert "as its blocker" in priority_event["content"]


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
                            "gsv": {
                                "scenarioId": "scenario-a",
                                "status": "yielded",
                            },
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
                        "calls": [
                            {
                                "time": {"start": 1.0, "end": 2.0},
                                "error": {
                                    "type": "ProviderError",
                                    "status_code": 429,
                                },
                            }
                        ],
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
    assert model["pass_at_5"] is None
    assert model["pass_power_5"] is None
    assert model["pass_at_10"] is None
    assert model["pass_power_10"] is None
    assert model["pass_at_1_ci95"] is not None
    assert model["pass_at_1_ci95"][0] <= model["pass_at_1"]
    assert model["pass_at_1_ci95"][1] >= model["pass_at_1"]
    assert model["calls_per_rollout"] == 1.0
    assert model["agent_seconds"] == 60.0
    assert model["wall_seconds"] == 30.0
    assert model["usage_coverage"] == 1.0
    assert model["request_errors"] == 0
    assert model["request_error_statuses"] == {}
    assert model["request_error_types"] == {}
    assert model["input_tokens"] == 4_500
    assert model["completion_tokens"] == 300
    assert model["cached_input_rate"] == 1 / 3
    assert model["e2e_output_tokens_per_second"] == 5.0
    assert model["aggregate_output_tokens_per_second"] == 10.0
    assert model["request_output_tokens_per_second"] == 25.0
    assert model["terminal_outcomes"] == {"yielded": 3}
    assert model["listed_cost_usd"] == pytest.approx(0.0051)
    assert model["listed_cost_complete"] is True
    scenario_summary = model["scenarios"]["scenario-a"]
    assert scenario_summary["score_mean"] == pytest.approx(0.8)
    assert {
        key: value for key, value in scenario_summary.items() if key != "score_mean"
    } == {
        "family": "fixtures",
        "rollouts": 3,
        "strict_passes": 2,
        "pass_at_1": 2 / 3,
        "pass_at_3": 1.0,
        "pass_power_3": 0.0,
        "pass_at_5": None,
        "pass_power_5": None,
        "pass_at_10": None,
        "pass_power_10": None,
    }
    assert model["families"]["fixtures"]["scenarios"] == 1
    assert model["families"]["fixtures"]["pass_at_1"] == 2 / 3
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
    assert legacy["request_errors"] == 1
    assert legacy["request_error_statuses"] == {"429": 1}
    assert legacy["request_error_types"] == {"ProviderError": 1}
    assert legacy["input_tokens"] is None
    assert legacy["completion_tokens"] is None
    assert legacy["listed_cost_usd"] is None
    assert legacy["listed_cost_complete"] is None
    assert "qwen/example" in render_markdown(summary)
    assert "legacy/example" in render_markdown(summary)
    assert "Failed model requests" in render_markdown(summary)
    assert "n/a" in render_markdown(summary)

    regraded = summarize_matrix(
        tmp_path,
        load_pricing(pricing_path),
        {
            "scenario-a": {
                "milestones": [
                    {
                        "id": "offline-regrade",
                        "description": "The revised outcome passes.",
                        "dimension": "outcome",
                        "weight": 1.0,
                        "requires": [],
                        "requiredForStrict": True,
                        "predicates": [
                            {
                                "type": "match",
                                "path": "/status",
                                "value": "yielded",
                            }
                        ],
                    }
                ],
                "constraints": [],
            }
        },
    )
    regraded_model = next(
        model for model in regraded["models"] if model["model"] == "qwen/example"
    )
    assert regraded_model["score_mean"] == 1.0
    assert regraded_model["strict_passes"] == 3


def test_matrix_report_computes_ten_run_reliability_and_family_intervals(
    tmp_path,
) -> None:
    run_dir = tmp_path / "current-model"
    run_dir.mkdir()
    envelopes = []
    for scenario_id, family, successes in [
        ("family-a:variant", "family-a", 7),
        ("family-b:variant", "family-b", 2),
    ]:
        for trial in range(10):
            passed = trial < successes
            envelopes.append(
                {
                    "ok": True,
                    "errors": [],
                    "traces": [
                        {
                            "ok": True,
                            "errors": [],
                            "agent": {"config": {"model": "current/model"}},
                            "rewards": {
                                "scenario_outcome": {
                                    "score": 1.0 if passed else 0.0
                                }
                            },
                            "timing": {"agent": {"start": 1.0, "end": 2.0}},
                            "calls": [],
                            "info": {
                                "gsv": {
                                    "scenarioId": scenario_id,
                                    "scenarioFamily": family,
                                    "status": "yielded",
                                },
                                "gsv_evaluation": {
                                    "strict_pass": passed,
                                    "raw_score": 1.0 if passed else 0.0,
                                    "milestones": [],
                                    "dimensions": {},
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

    model = summarize_matrix(tmp_path)["models"][0]

    assert model["rollouts"] == 20
    assert model["pass_at_1"] == 0.45
    assert model["pass_at_3"] == pytest.approx(
        (
            1 - math.comb(3, 3) / math.comb(10, 3)
            + 1
            - math.comb(8, 3) / math.comb(10, 3)
        )
        / 2
    )
    assert model["pass_at_5"] == pytest.approx(
        (1.0 + 1 - math.comb(8, 5) / math.comb(10, 5)) / 2
    )
    assert model["pass_power_5"] == pytest.approx(
        (math.comb(7, 5) / math.comb(10, 5)) / 2
    )
    assert model["pass_at_10"] == 1.0
    assert model["pass_power_10"] == 0.0
    assert model["pass_at_1_ci95"][0] <= 0.45
    assert model["pass_at_1_ci95"][1] >= 0.45
    assert set(model["families"]) == {"family-a", "family-b"}
    assert model["families"]["family-a"]["pass_at_1"] == 0.7
    assert model["families"]["family-b"]["pass_at_1"] == 0.2
    markdown = render_markdown({"models": [model]})
    assert "Pass@1 [95% CI]" in markdown
    assert "Pass@10" in markdown
