import json
from pathlib import Path

from gsv_v1.review import build_review_assignments, write_review_assignments


def _trace_envelope(episode_id: str, trace_id: str) -> dict:
    return {
        "id": episode_id,
        "traces": [
            {
                "id": trace_id,
                "agent": {"config": {"model": "test/model"}},
                "task": {
                    "data": {
                        "description": "Resolve the stateful request.",
                        "prompt": "Handle it safely.",
                        "system_prompt": "You are Ship.",
                        "scenario_id": "service:test",
                        "scenario": {
                            "id": "service:test",
                            "family": "service-account-operation",
                            "tags": ["stateful"],
                            "maxRuns": 3,
                            "maxTurns": 8,
                            "groundTruth": {"disposition": "approved"},
                            "world": {"delegates": [{"account": "reviewer"}]},
                            "components": {
                                "targets": [{"id": "service"}],
                                "events": [
                                    {
                                        "id": "approved",
                                        "at": "after-yield",
                                        "description": "Approval arrives.",
                                    }
                                ],
                            },
                        },
                        "evaluation": {
                            "milestones": [
                                {
                                    "id": "resolved",
                                    "weight": 1.0,
                                    "requiredForStrict": True,
                                    "predicates": [],
                                }
                            ],
                            "constraints": [],
                        },
                    }
                },
                "calls": [
                    {
                        "model": "test/model",
                        "error": {
                            "type": "rate_limit",
                            "status_code": 429,
                            "message": "slow down",
                            "opaque": "do not copy",
                        },
                    }
                ],
                "rewards": {"scenario_outcome": {"score": 0.5}},
                "info": {
                    "gsv": {
                        "scenarioId": "service:test",
                        "status": "yielded",
                        "runs": [{"processId": "ship", "run": 1}],
                    },
                    "gsv_evaluation": {
                        "raw_score": 0.5,
                        "strict_pass": False,
                        "hard_constraints_passed": True,
                        "milestones": [{"id": "resolved", "passed": False}],
                    },
                },
                "stop_condition": "yielded",
                "errors": [],
            }
        ],
    }


def test_builds_one_self_contained_review_assignment_per_trajectory(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "test-model"
    run_dir.mkdir()
    (run_dir / "traces.jsonl").write_text(
        "\n"
        + json.dumps(_trace_envelope("episode-1", "trace-1"))
        + "\n"
        + json.dumps(_trace_envelope("episode-2", "trace-2"))
        + "\n"
    )

    assignments = build_review_assignments(tmp_path)

    assert [assignment["trajectory_id"] for assignment in assignments] == [
        "episode-1",
        "episode-2",
    ]
    first = assignments[0]
    assert first["source"] == {
        "trace_file": "test-model/traces.jsonl",
        "line": 2,
        "trace_index": 0,
        "episode_id": "episode-1",
        "trace_id": "trace-1",
    }
    assert first["benchmark"] == {
        "scenario_id": "service:test",
        "family": "service-account-operation",
        "tags": ["stateful"],
        "description": "Resolve the stateful request.",
        "system_prompt": "You are Ship.",
        "user_prompt": "Handle it safely.",
        "max_runs": 3,
        "max_turns_per_process_run": 8,
        "ground_truth": {"disposition": "approved"},
        "target_ids": ["service"],
        "delegate_accounts": ["reviewer"],
        "scheduled_events": [
            {
                "id": "approved",
                "at": "after-yield",
                "description": "Approval arrives.",
            }
        ],
    }
    assert first["rubric"]["milestones"][0]["id"] == "resolved"
    assert first["scoring"]["milestones"] == [
        {"id": "resolved", "passed": False}
    ]
    assert first["outcome"]["request_errors"] == [
        {
            "call_index": 0,
            "type": "rate_limit",
            "status_code": 429,
            "message": "slow down",
        }
    ]
    assert first["review_output"] == (
        "trajectory-reviews/test-model/episode-1.md"
    )
    assert "JSONL line 2, trace index 0" in first["review_prompt"]
    assert "Score audit" in first["review_prompt"]
    assert "model behavior, provider/inference, harness/runtime" in first[
        "review_prompt"
    ]
    assert "do not copy" not in json.dumps(first)


def test_writes_jsonl_assignments_and_creates_parent_directory(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "model"
    run_dir.mkdir()
    (run_dir / "traces.jsonl").write_text(
        json.dumps(_trace_envelope("episode", "trace")) + "\n"
    )
    assignments = build_review_assignments(tmp_path)
    output = tmp_path / "generated" / "assignments.jsonl"

    assert write_review_assignments(assignments, output) == 1
    stored = [json.loads(line) for line in output.read_text().splitlines()]
    assert stored == assignments
