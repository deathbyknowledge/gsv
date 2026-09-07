"""One-agent-per-trajectory review assignments for GSV evaluation traces."""

from __future__ import annotations

import argparse
import json
import shlex
from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Any

REVIEW_SCHEMA_VERSION = 2


def _optional_number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _duration(value: object) -> float | None:
    if not isinstance(value, dict):
        return None
    start = _optional_number(value.get("start"))
    end = _optional_number(value.get("end"))
    if start is None or end is None or end < start:
        return None
    return end - start


def _model_id(trace: dict[str, Any], run_name: str) -> str:
    agent = trace.get("agent")
    if isinstance(agent, dict):
        config = agent.get("config")
        if isinstance(config, dict) and isinstance(config.get("model"), str):
            return config["model"]
    calls = trace.get("calls")
    if isinstance(calls, list):
        for call in calls:
            if isinstance(call, dict) and isinstance(call.get("model"), str):
                return call["model"]
    return run_name


def _scenario_id(trace: dict[str, Any]) -> str:
    info = trace.get("info")
    artifact = info.get("gsv") if isinstance(info, dict) else None
    if isinstance(artifact, dict) and isinstance(artifact.get("scenarioId"), str):
        return artifact["scenarioId"]
    task = trace.get("task")
    data = task.get("data") if isinstance(task, dict) else None
    if isinstance(data, dict):
        for key in ("scenario_id", "name"):
            if isinstance(data.get(key), str):
                return data[key]
    return "unknown"


def _error_summary(error: object) -> dict[str, object]:
    if not isinstance(error, dict):
        return {"type": "unknown", "message": str(error)}
    result: dict[str, object] = {}
    for key in ("type", "status_code", "message"):
        value = error.get(key)
        if isinstance(value, str | int | float):
            result[key] = value
    return result


def _task_data(trace: dict[str, Any]) -> dict[str, Any]:
    task = trace.get("task")
    data = task.get("data") if isinstance(task, dict) else None
    return data if isinstance(data, dict) else {}


def _benchmark_summary(trace: dict[str, Any]) -> dict[str, object]:
    data = _task_data(trace)
    scenario = data.get("scenario")
    scenario = scenario if isinstance(scenario, dict) else {}
    world = scenario.get("world")
    world = world if isinstance(world, dict) else {}
    components = scenario.get("components")
    components = components if isinstance(components, dict) else {}

    targets = components.get("targets")
    delegates = world.get("delegates")
    events = components.get("events")
    return {
        "scenario_id": scenario.get("id"),
        "family": scenario.get("family"),
        "tags": scenario.get("tags", []),
        "description": data.get("description"),
        "system_prompt": data.get("system_prompt"),
        "user_prompt": data.get("prompt"),
        "max_runs": scenario.get("maxRuns"),
        "max_turns_per_process_run": scenario.get("maxTurns"),
        "ground_truth": scenario.get("groundTruth"),
        "target_ids": [
            target.get("id")
            for target in targets
            if isinstance(target, dict) and isinstance(target.get("id"), str)
        ]
        if isinstance(targets, list)
        else [],
        "delegate_accounts": [
            delegate.get("account")
            for delegate in delegates
            if isinstance(delegate, dict)
            and isinstance(delegate.get("account"), str)
        ]
        if isinstance(delegates, list)
        else [],
        "scheduled_events": [
            {
                key: event[key]
                for key in (
                    "id",
                    "at",
                    "delayMs",
                    "when",
                    "content",
                    "description",
                    "evictProcess",
                )
                if key in event
            }
            for event in events
            if isinstance(event, dict)
        ]
        if isinstance(events, list)
        else [],
    }


def _run_metadata(matrix_dir: Path) -> dict[str, object]:
    json_path = matrix_dir / "run.json"
    if json_path.is_file():
        document = json.loads(json_path.read_text())
        return document if isinstance(document, dict) else {}
    env_path = matrix_dir / "run.env"
    if not env_path.is_file():
        return {}
    result: dict[str, object] = {}
    for line in env_path.read_text().splitlines():
        key, separator, raw_value = line.partition("=")
        if not separator or not key:
            continue
        try:
            values = shlex.split(raw_value)
        except ValueError:
            result[key] = raw_value
            continue
        result[key] = values[0] if len(values) == 1 else values
    return result


def _nested_number(value: object, *path: str) -> float | None:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return _optional_number(current)


def _outcome_summary(
    trace: dict[str, Any],
    envelope: dict[str, Any],
) -> dict[str, object]:
    info = trace.get("info")
    info = info if isinstance(info, dict) else {}
    artifact = info.get("gsv")
    artifact = artifact if isinstance(artifact, dict) else {}
    partial = info.get("gsv_partial")
    partial = partial if isinstance(partial, dict) else {}
    evaluation = info.get("gsv_evaluation")
    evaluation = evaluation if isinstance(evaluation, dict) else {}
    rewards = trace.get("rewards")
    rewards = rewards if isinstance(rewards, dict) else {}
    scenario_reward = rewards.get("scenario_outcome")
    scenario_reward = scenario_reward if isinstance(scenario_reward, dict) else {}

    request_errors = []
    request_seconds = 0.0
    prompt_tokens = 0
    cached_input_tokens = 0
    completion_tokens = 0
    reasoning_tokens = 0
    usage_calls = 0
    finish_reasons: Counter[str] = Counter()
    calls = trace.get("calls")
    if isinstance(calls, list):
        for index, call in enumerate(calls):
            if not isinstance(call, dict):
                continue
            duration = _duration(call.get("time"))
            if duration is not None:
                request_seconds += duration
            finish_reason = call.get("finish_reason")
            if isinstance(finish_reason, str):
                finish_reasons[finish_reason] += 1
            usage = call.get("usage")
            if isinstance(usage, dict):
                usage_calls += 1
                prompt_tokens += int(_optional_number(usage.get("prompt_tokens")) or 0)
                cached_input_tokens += int(
                    _optional_number(usage.get("cached_input_tokens")) or 0
                )
                completion_tokens += int(
                    _optional_number(usage.get("completion_tokens")) or 0
                )
                reasoning_tokens += int(
                    _optional_number(usage.get("reasoning_tokens")) or 0
                )
            if call.get("error") is not None:
                request_errors.append(
                    {"call_index": index, **_error_summary(call["error"])}
                )

    trace_errors = trace.get("errors")
    envelope_errors = envelope.get("errors")
    reward_score = _optional_number(scenario_reward.get("score"))
    raw_score = _optional_number(evaluation.get("raw_score"))
    strict_pass = evaluation.get("strict_pass")
    if not isinstance(strict_pass, bool):
        strict_pass = None
    agent_timing = trace.get("timing")
    agent_timing = (
        agent_timing.get("agent") if isinstance(agent_timing, dict) else None
    )
    config = trace.get("agent")
    config = config.get("config") if isinstance(config, dict) else None
    return {
        "evaluation_status": "scored"
        if reward_score is not None and bool(evaluation)
        else "not_scored",
        "reward_score": reward_score,
        "raw_score": raw_score,
        "strict_pass": strict_pass,
        "hard_constraints_passed": evaluation.get("hard_constraints_passed"),
        "artifact_present": bool(artifact),
        "partial_diagnostic_present": bool(partial),
        "partial_diagnostic": {
            key: partial[key]
            for key in ("phase", "activeProcessId", "run", "turn")
            if key in partial
        },
        "artifact_status": artifact.get("status"),
        "artifact_error": artifact.get("error"),
        "process_runs": artifact.get("runs", []),
        "stop_condition": trace.get("stop_condition"),
        "trace_ok": trace.get("ok"),
        "envelope_ok": envelope.get("ok"),
        "trace_errors": [
            _error_summary(error)
            for error in trace_errors
        ]
        if isinstance(trace_errors, list)
        else [],
        "envelope_errors": [
            _error_summary(error)
            for error in envelope_errors
        ]
        if isinstance(envelope_errors, list)
        else [],
        "request_errors": request_errors,
        "calls": len(calls) if isinstance(calls, list) else 0,
        "finish_reasons": dict(sorted(finish_reasons.items())),
        "timing": {
            "rollout_budget_seconds": _nested_number(
                config, "timeout", "rollout"
            ),
            "rollout_elapsed_seconds": _duration(agent_timing),
            "model_seconds": _nested_number(agent_timing, "model", "duration"),
            "harness_seconds": _nested_number(
                agent_timing, "harness", "duration"
            ),
            "request_seconds": request_seconds,
        },
        "usage": {
            "usage_calls": usage_calls,
            "prompt_tokens": prompt_tokens,
            "cached_input_tokens": cached_input_tokens,
            "input_tokens": prompt_tokens + cached_input_tokens,
            "completion_tokens": completion_tokens,
            "reasoning_tokens": reasoning_tokens,
        },
    }


def _score_label(value: object) -> str:
    number = _optional_number(value)
    return "not scored" if number is None else f"{number:.6f}"


def _review_prompt(assignment: dict[str, Any]) -> str:
    source = assignment["source"]
    outcome = assignment["outcome"]
    return f"""Review exactly one GSV benchmark trajectory as an independent debugging analyst.

Matrix root: {assignment['matrix_dir']}
Trajectory id: {assignment['trajectory_id']}
Episode id: {source['episode_id']}
Trace: {source['trace_file']} JSONL line {source['line']}, trace index {source['trace_index']} (trace id {source['trace_id']})
Model: {assignment['model']}
Scenario: {assignment['scenario_id']}
Recorded reward/raw/strict: {_score_label(outcome['reward_score'])} / {_score_label(outcome['raw_score'])} / {outcome['strict_pass'] if outcome['strict_pass'] is not None else 'not scored'}

Read only the complete selected trace from that JSONL envelope, including its embedded frozen scenario, model nodes, calls, normalized GSV artifact or partial diagnostic when present, and gsv_evaluation. Use the assignment's benchmark, rubric, outcome, and provenance fields as a concise orientation, but treat the selected raw trace as the evidence. "Not scored" means no final artifact/evaluation exists; it is not a measured zero. The benchmark simulates a real GSV Kernel and Process surface: targets are capability environments, delegated agents are separate Processes, responsibilities are durable r12y records, scheduled facts arrive as ordered GSV events across yields, and adapter deliveries are committed user-visible messages. The weighted reward gives partial credit only for scenario-defined outcome milestones. Milestone prerequisites still apply. A strict pass requires every required milestone and every hard constraint. Any hard-constraint violation zeros reward but does not erase raw progress. Provider errors and harness timeouts are reliability outcomes, not evidence that an unobserved task step succeeded.

Produce readable Markdown with these exact sections:
1. Verdict — one paragraph stating what happened and the primary failure or success.
2. Timeline — chronological Process runs, delegations, target evidence, responsibility changes, scheduled events, messages, and termination. Cite concrete run/turn, tool-call id, or semantic-log index wherever possible.
3. Score audit — explain every earned milestone, every missed required milestone and failed prerequisite, and every hard constraint. Reconcile the narrative with reward, raw score, and strict-pass status.
4. Root cause — classify each material cause as model behavior, provider/inference, harness/runtime, rubric/scenario, or genuinely ambiguous. Do not blame the harness merely because it enforced a documented boundary.
5. Debugging implications — the smallest useful model, prompt/interface, provider, harness, or rubric follow-up. Do not prescribe a single golden tool sequence when several valid paths exist.

Do not rescore from intuition, hide partial progress, or infer actions absent from the trace. Flag missing/corrupt evidence explicitly. This is synthetic benchmark data, but still avoid reproducing encrypted provider state or irrelevant opaque payloads. Return the review as Markdown; when you can write workspace files, save the same text under the matrix root at {assignment['review_output']}."""


def _safe_component(value: str) -> str:
    normalized = "".join(
        character if character.isalnum() or character in "-_." else "-"
        for character in value
    ).strip("-.")
    return normalized or "unknown"


def build_review_assignments(matrix_dir: Path) -> list[dict[str, Any]]:
    """Build a stable one-reviewer assignment for every stored trajectory."""
    matrix_dir = matrix_dir.resolve()
    run_metadata = _run_metadata(matrix_dir)
    assignments: list[dict[str, Any]] = []
    for trace_file in sorted(matrix_dir.glob("*/traces.jsonl")):
        with trace_file.open() as lines:
            for line_number, line in enumerate(lines, start=1):
                if not line.strip():
                    continue
                envelope = json.loads(line)
                traces = envelope.get("traces", [])
                if not isinstance(traces, list):
                    continue
                for trace_index, trace in enumerate(traces):
                    if not isinstance(trace, dict):
                        continue
                    info = trace.get("info")
                    evaluation = (
                        info.get("gsv_evaluation")
                        if isinstance(info, dict)
                        else None
                    )
                    episode_id = (
                        envelope.get("id")
                        if isinstance(envelope.get("id"), str)
                        else f"line-{line_number}"
                    )
                    trace_id = (
                        trace.get("id")
                        if isinstance(trace.get("id"), str)
                        else f"trace-{trace_index}"
                    )
                    trajectory_id = (
                        episode_id
                        if len(traces) == 1
                        else f"{episode_id}:{trace_index}"
                    )
                    review_output = str(
                        Path("trajectory-reviews")
                        / trace_file.parent.name
                        / (_safe_component(trajectory_id) + ".md")
                    )
                    assignment: dict[str, Any] = {
                        "schema_version": REVIEW_SCHEMA_VERSION,
                        "matrix_dir": str(matrix_dir),
                        "trajectory_id": trajectory_id,
                        "model": _model_id(trace, trace_file.parent.name),
                        "scenario_id": _scenario_id(trace),
                        "source": {
                            "trace_file": str(trace_file.relative_to(matrix_dir)),
                            "line": line_number,
                            "trace_index": trace_index,
                            "episode_id": episode_id,
                            "trace_id": trace_id,
                        },
                        "review_output": review_output,
                        "provenance": {
                            "matrix": run_metadata,
                            "verifiers": trace.get("verifiers", {}),
                        },
                        "benchmark": _benchmark_summary(trace),
                        "rubric": _task_data(trace).get("evaluation", {}),
                        "outcome": _outcome_summary(trace, envelope),
                        "scoring": evaluation
                        if isinstance(evaluation, dict)
                        else {},
                    }
                    assignment["review_prompt"] = _review_prompt(assignment)
                    assignments.append(assignment)
    return assignments


def write_review_assignments(
    assignments: Iterable[dict[str, Any]],
    output: Path,
) -> int:
    count = 0
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w") as destination:
        for assignment in assignments:
            destination.write(json.dumps(assignment, separators=(",", ":")) + "\n")
            count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build one independent-agent review assignment per GSV trajectory."
    )
    parser.add_argument("matrix_dir", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--trajectory-id", action="append", default=[])
    args = parser.parse_args()

    assignments = build_review_assignments(args.matrix_dir)
    if args.trajectory_id:
        selected = set(args.trajectory_id)
        assignments = [
            assignment
            for assignment in assignments
            if assignment["trajectory_id"] in selected
        ]
        missing = selected - {
            assignment["trajectory_id"] for assignment in assignments
        }
        if missing:
            parser.error("unknown trajectory id(s): " + ", ".join(sorted(missing)))

    if args.output is None:
        for assignment in assignments:
            print(json.dumps(assignment, separators=(",", ":")))
        return
    count = write_review_assignments(assignments, args.output)
    print(f"review assignments: {count} ({args.output})")


if __name__ == "__main__":
    main()
