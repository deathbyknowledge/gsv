import json
from pathlib import Path

from gsv_v1.review import build_review_assignments, write_review_assignments


def _trace_envelope(episode_id: str, trace_id: str) -> dict:
    return {
        "id": episode_id,
        "traces": [
            {
                "id": trace_id,
                "agent": {
                    "config": {
                        "model": "test/model",
                        "timeout": {"rollout": 900.0},
                    }
                },
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
                        "time": {"start": 10.0, "end": 12.5},
                        "finish_reason": "tool_calls",
                        "usage": {
                            "prompt_tokens": 100,
                            "cached_input_tokens": 20,
                            "completion_tokens": 30,
                            "reasoning_tokens": 10,
                        },
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
                "timing": {
                    "agent": {
                        "start": 10.0,
                        "end": 15.0,
                        "model": {"duration": 4.0},
                        "harness": {"duration": 1.0},
                    }
                },
            }
        ],
    }


def test_builds_one_self_contained_review_assignment_per_trajectory(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "test-model"
    run_dir.mkdir()
    (tmp_path / "run.json").write_text(
        json.dumps({"gsv_git_commit": "abc123", "gsv_git_dirty": False})
    )
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
    assert first["schema_version"] == 2
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
    assert first["provenance"]["matrix"] == {
        "gsv_git_commit": "abc123",
        "gsv_git_dirty": False,
    }
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
    assert first["outcome"]["evaluation_status"] == "scored"
    assert first["outcome"]["timing"] == {
        "rollout_budget_seconds": 900.0,
        "rollout_elapsed_seconds": 5.0,
        "model_seconds": 4.0,
        "harness_seconds": 1.0,
        "request_seconds": 2.5,
    }
    assert first["outcome"]["usage"] == {
        "usage_calls": 1,
        "prompt_tokens": 100,
        "cached_input_tokens": 20,
        "input_tokens": 120,
        "completion_tokens": 30,
        "reasoning_tokens": 10,
    }
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


def test_timeout_assignment_preserves_unscored_state_and_timing(
    tmp_path: Path,
) -> None:
    envelope = _trace_envelope("timeout-episode", "timeout-trace")
    envelope["ok"] = False
    trace = envelope["traces"][0]
    trace["ok"] = False
    trace["stop_condition"] = "error"
    trace["rewards"] = {}
    trace["info"] = {
        "gsv_partial": {
            "phase": "model.request",
            "activeProcessId": "ship",
            "run": 2,
            "turn": 7,
        }
    }
    trace["errors"] = [
        {
            "type": "HarnessError",
            "message": "agent timeout: rollout exceeded its 900s budget",
            "traceback": "private traceback",
        }
    ]
    trace["timing"] = {
        "agent": {
            "start": 100.0,
            "end": 1_000.0,
            "model": {"duration": 887.85},
            "harness": {"duration": 12.15},
        }
    }
    run_dir = tmp_path / "timeout-model"
    run_dir.mkdir()
    (run_dir / "traces.jsonl").write_text(json.dumps(envelope) + "\n")

    assignment = build_review_assignments(tmp_path)[0]
    outcome = assignment["outcome"]

    assert outcome["evaluation_status"] == "not_scored"
    assert outcome["reward_score"] is None
    assert outcome["raw_score"] is None
    assert outcome["strict_pass"] is None
    assert outcome["artifact_present"] is False
    assert outcome["partial_diagnostic_present"] is True
    assert outcome["partial_diagnostic"] == {
        "phase": "model.request",
        "activeProcessId": "ship",
        "run": 2,
        "turn": 7,
    }
    assert outcome["timing"]["rollout_elapsed_seconds"] == 900.0
    assert outcome["timing"]["model_seconds"] == 887.85
    assert outcome["timing"]["harness_seconds"] == 12.15
    assert "Recorded reward/raw/strict: not scored / not scored / not scored" in (
        assignment["review_prompt"]
    )
    assert "private traceback" not in json.dumps(assignment)
