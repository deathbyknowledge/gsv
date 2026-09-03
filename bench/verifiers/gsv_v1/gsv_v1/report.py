"""Offline summaries for GSV Verifiers v1 evaluation matrices."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

from gsv_v1.evaluation import evaluate_scenario
from gsv_v1.families import load_scenarios


def _number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0.0
    return float(value)


def _duration(timing: object) -> float:
    if not isinstance(timing, dict):
        return 0.0
    start = _number(timing.get("start"))
    end = _number(timing.get("end"))
    return max(0.0, end - start)


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(0, math.ceil(fraction * len(ordered)) - 1)
    return ordered[rank]


def _pass_at_k(trials: list[bool], k: int) -> float | None:
    if len(trials) < k:
        return None
    successes = sum(trials)
    return 1.0 - (
        math.comb(len(trials) - successes, k) / math.comb(len(trials), k)
        if len(trials) - successes >= k
        else 0.0
    )


def _pass_power_k(trials: list[bool], k: int) -> float | None:
    if len(trials) < k:
        return None
    successes = sum(trials)
    return (
        math.comb(successes, k) / math.comb(len(trials), k) if successes >= k else 0.0
    )


def _macro_pass_metric(
    scenario_trials: dict[str, list[bool]],
    k: int,
    metric,
) -> float | None:
    values = [
        value
        for trials in scenario_trials.values()
        if (value := metric(trials, k)) is not None
    ]
    return statistics.fmean(values) if values else None


def _quantile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    position = fraction * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _stratified_pass_at_1_ci(
    scenario_trials: dict[str, list[bool]],
    seed: str,
    replicates: int = 10_000,
) -> list[float] | None:
    """Bootstrap scenario selection and within-scenario trial variation."""
    scenarios = sorted(
        scenario_id for scenario_id, trials in scenario_trials.items() if trials
    )
    if not scenarios:
        return None
    seed_bytes = hashlib.sha256(seed.encode()).digest()[:8]
    rng = random.Random(int.from_bytes(seed_bytes, "big"))
    estimates: list[float] = []
    for _ in range(replicates):
        outcomes: list[bool] = []
        for _ in scenarios:
            trials = scenario_trials[rng.choice(scenarios)]
            outcomes.extend(rng.choice(trials) for _ in trials)
        estimates.append(sum(outcomes) / len(outcomes))
    return [_quantile(estimates, 0.025), _quantile(estimates, 0.975)]


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


def _scenario_family(trace: dict[str, Any], scenario_id: str) -> str:
    info = trace.get("info")
    artifact = info.get("gsv") if isinstance(info, dict) else None
    if isinstance(artifact, dict) and isinstance(
        artifact.get("scenarioFamily"), str
    ):
        return artifact["scenarioFamily"]
    return scenario_id.split(":", 1)[0] if ":" in scenario_id else "fixtures"


def _terminal_outcome(trace: dict[str, Any]) -> str | None:
    info = trace.get("info")
    artifact = info.get("gsv") if isinstance(info, dict) else None
    if isinstance(artifact, dict) and isinstance(artifact.get("status"), str):
        return artifact["status"]
    errors = trace.get("errors")
    if isinstance(errors, list):
        messages = " ".join(
            error.get("message", "")
            for error in errors
            if isinstance(error, dict) and isinstance(error.get("message"), str)
        ).lower()
        if "timeout" in messages:
            return "timeout"
    return "harness_error" if trace.get("ok") is False else None


def load_pricing(path: Path | None) -> dict[str, dict[str, float]]:
    if path is None or not path.is_file():
        return {}
    document = json.loads(path.read_text())
    models = document.get("data", []) if isinstance(document, dict) else []
    result: dict[str, dict[str, float]] = {}
    for model in models:
        if not isinstance(model, dict) or not isinstance(model.get("id"), str):
            continue
        pricing = model.get("pricing")
        if not isinstance(pricing, dict):
            continue
        result[model["id"]] = {
            "input_usd_per_mtok": _number(pricing.get("input_usd_per_mtok")),
            "output_usd_per_mtok": _number(pricing.get("output_usd_per_mtok")),
        }
    return result


def load_evaluations(path: Path | None) -> dict[str, dict[str, Any]]:
    if path is None:
        return {}
    return {scenario["id"]: scenario["evaluation"] for scenario in load_scenarios(path)}


def summarize_matrix(
    matrix_dir: Path,
    pricing: dict[str, dict[str, float]] | None = None,
    evaluations: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    trace_files = sorted(matrix_dir.glob("*/traces.jsonl"))
    for trace_file in trace_files:
        with trace_file.open() as lines:
            for line in lines:
                if not line.strip():
                    continue
                envelope = json.loads(line)
                traces = envelope.get("traces", [])
                if not isinstance(traces, list):
                    continue
                for trace in traces:
                    if not isinstance(trace, dict):
                        continue
                    model_id = _model_id(trace, trace_file.parent.name)
                    groups[model_id].append({"envelope": envelope, "trace": trace})

    prices = pricing or {}
    models: list[dict[str, Any]] = []
    for model_id, entries in sorted(groups.items()):
        scores: list[float] = []
        raw_scores: list[float] = []
        agent_seconds: list[float] = []
        agent_starts: list[float] = []
        agent_ends: list[float] = []
        request_seconds = 0.0
        prompt_tokens = 0
        completion_tokens = 0
        cached_input_tokens = 0
        reasoning_tokens = 0
        call_count = 0
        usage_call_count = 0
        error_count = 0
        milestones: dict[str, dict[str, Any]] = {}
        dimensions: dict[str, dict[str, Any]] = {}
        constraints: dict[str, dict[str, Any]] = {}
        terminal_outcomes: dict[str, int] = defaultdict(int)
        scenario_trials: dict[str, list[bool]] = defaultdict(list)
        scenario_scores: dict[str, list[float]] = defaultdict(list)
        scenario_families: dict[str, str] = {}
        strict_passes = 0

        for entry in entries:
            envelope = entry["envelope"]
            trace = entry["trace"]
            rewards = trace.get("rewards", {})
            scenario_reward = (
                rewards.get("scenario_outcome", {}) if isinstance(rewards, dict) else {}
            )
            score = _number(
                scenario_reward.get("score")
                if isinstance(scenario_reward, dict)
                else None
            )
            timing = trace.get("timing", {})
            agent_timing = timing.get("agent", {}) if isinstance(timing, dict) else {}
            agent_seconds.append(_duration(agent_timing))
            if isinstance(agent_timing, dict):
                start = _number(agent_timing.get("start"))
                end = _number(agent_timing.get("end"))
                if start and end >= start:
                    agent_starts.append(start)
                    agent_ends.append(end)

            calls = trace.get("calls", [])
            if isinstance(calls, list):
                for call in calls:
                    if not isinstance(call, dict):
                        continue
                    call_count += 1
                    request_seconds += _duration(call.get("time"))
                    usage = call.get("usage")
                    if not isinstance(usage, dict):
                        continue
                    usage_call_count += 1
                    prompt_tokens += int(_number(usage.get("prompt_tokens")))
                    completion_tokens += int(_number(usage.get("completion_tokens")))
                    cached_input_tokens += int(
                        _number(usage.get("cached_input_tokens"))
                    )
                    reasoning_tokens += int(_number(usage.get("reasoning_tokens")))

            envelope_errors = envelope.get("errors", [])
            trace_errors = trace.get("errors", [])
            if (
                envelope.get("ok") is False
                or trace.get("ok") is False
                or bool(envelope_errors)
                or bool(trace_errors)
            ):
                error_count += 1
            terminal_outcome = _terminal_outcome(trace)
            if terminal_outcome is not None:
                terminal_outcomes[terminal_outcome] += 1

            info = trace.get("info", {})
            evaluation = (
                info.get("gsv_evaluation", {}) if isinstance(info, dict) else {}
            )
            scenario_id = _scenario_id(trace)
            artifact = info.get("gsv") if isinstance(info, dict) else None
            configured_evaluation = (evaluations or {}).get(scenario_id)
            if isinstance(artifact, dict) and configured_evaluation is not None:
                evaluation = evaluate_scenario(
                    configured_evaluation,
                    artifact,
                    info.get("gsv_external"),
                )
                score = _number(evaluation.get("reward_score"))
            scores.append(score)
            raw_scores.append(
                _number(evaluation.get("raw_score"))
                if isinstance(evaluation, dict) and "raw_score" in evaluation
                else score
            )
            strict_pass = (
                evaluation.get("strict_pass") is True
                if isinstance(evaluation, dict)
                else False
            )
            strict_passes += int(strict_pass)
            scenario_trials[scenario_id].append(strict_pass)
            scenario_scores[scenario_id].append(score)
            scenario_families[scenario_id] = _scenario_family(trace, scenario_id)

            evaluated_milestones = (
                evaluation.get("milestones", []) if isinstance(evaluation, dict) else []
            )
            if isinstance(evaluated_milestones, list):
                for milestone in evaluated_milestones:
                    if not isinstance(milestone, dict):
                        continue
                    milestone_id = milestone.get("id")
                    if not isinstance(milestone_id, str):
                        continue
                    summary = milestones.setdefault(
                        milestone_id,
                        {
                            "description": milestone.get("description", ""),
                            "dimension": milestone.get("dimension", ""),
                            "passed": 0,
                            "total": 0,
                        },
                    )
                    summary["total"] += 1
                    summary["passed"] += int(milestone.get("passed") is True)

            evaluated_dimensions = (
                evaluation.get("dimensions", {}) if isinstance(evaluation, dict) else {}
            )
            if isinstance(evaluated_dimensions, dict):
                for dimension_id, dimension in evaluated_dimensions.items():
                    if not isinstance(dimension_id, str) or not isinstance(
                        dimension, dict
                    ):
                        continue
                    summary = dimensions.setdefault(
                        dimension_id, {"score_total": 0.0, "rollouts": 0}
                    )
                    summary["score_total"] += _number(dimension.get("score"))
                    summary["rollouts"] += 1

            evaluated_constraints = (
                evaluation.get("constraints", [])
                if isinstance(evaluation, dict)
                else []
            )
            if isinstance(evaluated_constraints, list):
                for constraint in evaluated_constraints:
                    if not isinstance(constraint, dict):
                        continue
                    constraint_id = constraint.get("id")
                    if not isinstance(constraint_id, str):
                        continue
                    summary = constraints.setdefault(
                        constraint_id,
                        {
                            "description": constraint.get("description", ""),
                            "severity": constraint.get("severity", ""),
                            "violations": 0,
                            "total": 0,
                        },
                    )
                    summary["total"] += 1
                    summary["violations"] += int(constraint.get("passed") is not True)

        count = len(entries)
        total_agent_seconds = sum(agent_seconds)
        wall_seconds = (
            max(agent_ends) - min(agent_starts)
            if agent_starts and agent_ends
            else total_agent_seconds
        )
        input_tokens = prompt_tokens + cached_input_tokens
        usage_complete = usage_call_count == call_count and call_count > 0
        price = prices.get(model_id)
        estimated_cost = None
        if price is not None and usage_call_count:
            estimated_cost = (
                input_tokens * price["input_usd_per_mtok"]
                + completion_tokens * price["output_usd_per_mtok"]
            ) / 1_000_000
        for milestone in milestones.values():
            total = milestone["total"]
            milestone["rate"] = milestone["passed"] / total if total else 0.0
        for dimension in dimensions.values():
            rollouts = dimension["rollouts"]
            dimension["score_mean"] = (
                dimension.pop("score_total") / rollouts if rollouts else 0.0
            )
        scenarios = {}
        for scenario_id, trials in sorted(scenario_trials.items()):
            per_scenario_scores = scenario_scores[scenario_id]
            scenario_strict_passes = sum(trials)
            scenarios[scenario_id] = {
                "family": scenario_families[scenario_id],
                "rollouts": len(trials),
                "score_mean": statistics.fmean(per_scenario_scores),
                "strict_passes": scenario_strict_passes,
                "pass_at_1": scenario_strict_passes / len(trials),
                "pass_at_3": _pass_at_k(trials, 3),
                "pass_power_3": _pass_power_k(trials, 3),
                "pass_at_5": _pass_at_k(trials, 5),
                "pass_power_5": _pass_power_k(trials, 5),
                "pass_at_10": _pass_at_k(trials, 10),
                "pass_power_10": _pass_power_k(trials, 10),
            }

        families: dict[str, dict[str, Any]] = {}
        for family in sorted(set(scenario_families.values())):
            family_trial_map = {
                scenario_id: trials
                for scenario_id, trials in scenario_trials.items()
                if scenario_families[scenario_id] == family
            }
            family_score_values = [
                score
                for scenario_id in family_trial_map
                for score in scenario_scores[scenario_id]
            ]
            family_trials = sum(map(len, family_trial_map.values()))
            family_passes = sum(sum(trials) for trials in family_trial_map.values())
            families[family] = {
                "scenarios": len(family_trial_map),
                "rollouts": family_trials,
                "score_mean": statistics.fmean(family_score_values),
                "strict_passes": family_passes,
                "pass_at_1": family_passes / family_trials,
                "pass_at_1_ci95": _stratified_pass_at_1_ci(
                    family_trial_map, f"{model_id}:{family}"
                ),
                "pass_at_3": _macro_pass_metric(
                    family_trial_map, 3, _pass_at_k
                ),
                "pass_power_3": _macro_pass_metric(
                    family_trial_map, 3, _pass_power_k
                ),
                "pass_at_5": _macro_pass_metric(
                    family_trial_map, 5, _pass_at_k
                ),
                "pass_power_5": _macro_pass_metric(
                    family_trial_map, 5, _pass_power_k
                ),
                "pass_at_10": _macro_pass_metric(
                    family_trial_map, 10, _pass_at_k
                ),
                "pass_power_10": _macro_pass_metric(
                    family_trial_map, 10, _pass_power_k
                ),
            }

        models.append(
            {
                "model": model_id,
                "rollouts": count,
                "score_mean": statistics.fmean(scores) if scores else 0.0,
                "raw_score_mean": (statistics.fmean(raw_scores) if raw_scores else 0.0),
                "score_median": statistics.median(scores) if scores else 0.0,
                "strict_passes": strict_passes,
                "pass_at_1": strict_passes / count if count else 0.0,
                "pass_at_1_ci95": _stratified_pass_at_1_ci(
                    scenario_trials, model_id
                ),
                "pass_at_3": _macro_pass_metric(
                    scenario_trials, 3, _pass_at_k
                ),
                "pass_power_3": _macro_pass_metric(
                    scenario_trials, 3, _pass_power_k
                ),
                "pass_at_5": _macro_pass_metric(
                    scenario_trials, 5, _pass_at_k
                ),
                "pass_power_5": _macro_pass_metric(
                    scenario_trials, 5, _pass_power_k
                ),
                "pass_at_10": _macro_pass_metric(
                    scenario_trials, 10, _pass_at_k
                ),
                "pass_power_10": _macro_pass_metric(
                    scenario_trials, 10, _pass_power_k
                ),
                "errors": error_count,
                "calls": call_count,
                "calls_per_rollout": call_count / count if count else 0.0,
                "agent_seconds": total_agent_seconds,
                "wall_seconds": wall_seconds,
                "agent_seconds_p50": _percentile(agent_seconds, 0.5),
                "agent_seconds_p95": _percentile(agent_seconds, 0.95),
                "request_seconds": request_seconds,
                "usage_calls": usage_call_count,
                "usage_coverage": (
                    usage_call_count / call_count if call_count else 0.0
                ),
                "prompt_tokens": prompt_tokens if usage_call_count else None,
                "input_tokens": input_tokens if usage_call_count else None,
                "completion_tokens": (completion_tokens if usage_call_count else None),
                "cached_input_tokens": (
                    cached_input_tokens if usage_call_count else None
                ),
                "reasoning_tokens": reasoning_tokens if usage_call_count else None,
                "cached_input_rate": (
                    cached_input_tokens / input_tokens if input_tokens else 0.0
                )
                if usage_call_count
                else None,
                "e2e_output_tokens_per_second": (
                    completion_tokens / total_agent_seconds
                    if usage_call_count and total_agent_seconds
                    else 0.0
                )
                if usage_call_count
                else None,
                "aggregate_output_tokens_per_second": (
                    completion_tokens / wall_seconds
                    if usage_call_count and wall_seconds
                    else 0.0
                )
                if usage_call_count
                else None,
                "request_output_tokens_per_second": (
                    completion_tokens / request_seconds if request_seconds else 0.0
                )
                if usage_call_count
                else None,
                "listed_cost_usd": estimated_cost,
                "listed_cost_complete": (
                    usage_complete if estimated_cost is not None else None
                ),
                "milestones": milestones,
                "dimensions": dimensions,
                "constraints": constraints,
                "scenarios": scenarios,
                "families": families,
                "terminal_outcomes": dict(sorted(terminal_outcomes.items())),
            }
        )

    return {
        "matrix_dir": str(matrix_dir.resolve()),
        "trace_files": len(trace_files),
        "models": models,
    }


def render_markdown(summary: dict[str, Any]) -> str:
    models = summary["models"]
    if not models:
        return "No traces found."
    lines = [
        "| Model | n | Reward | Raw | Median | Strict | Pass@1 [95% CI] | Pass@3 | Pass^3 | Pass@5 | Pass^5 | Pass@10 | Pass^10 | Errors | Calls/n | P50 s | Input tok | Output tok | E2E tok/s/process | Aggregate tok/s | Request tok/s | Cached | Listed cost |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for model in models:
        cost = model["listed_cost_usd"]
        cost_text = (
            ("" if model["listed_cost_complete"] else "≥") + f"${cost:.4f}"
            if cost is not None
            else "n/a"
        )
        input_tokens = model["input_tokens"]
        output_tokens = model["completion_tokens"]
        e2e_rate = model["e2e_output_tokens_per_second"]
        aggregate_rate = model["aggregate_output_tokens_per_second"]
        request_rate = model["request_output_tokens_per_second"]
        cached_rate = model["cached_input_rate"]
        pass_at_1_ci95 = model["pass_at_1_ci95"]
        pass_at_1_text = f"{model['pass_at_1']:.1%}"
        if pass_at_1_ci95 is not None:
            pass_at_1_text += (
                f" [{pass_at_1_ci95[0]:.1%}, {pass_at_1_ci95[1]:.1%}]"
            )
        lines.append(
            "| {model} | {rollouts} | {mean:.3f} | {raw:.3f} | {median:.3f} | "
            "{strict}/{rollouts} | {pass1} | {pass3} | {pass_power3} | "
            "{pass5} | {pass_power5} | {pass10} | {pass_power10} | "
            "{errors} | {calls:.1f} | {seconds:.1f} | "
            "{prompt} | {output} | {e2e_rate} | {aggregate_rate} | {request_rate} | "
            "{cached} | {cost} |".format(
                model=model["model"],
                rollouts=model["rollouts"],
                mean=model["score_mean"],
                raw=model["raw_score_mean"],
                median=model["score_median"],
                strict=model["strict_passes"],
                pass1=pass_at_1_text,
                pass3=(
                    f"{model['pass_at_3']:.1%}"
                    if model["pass_at_3"] is not None
                    else "n/a"
                ),
                pass_power3=(
                    f"{model['pass_power_3']:.1%}"
                    if model["pass_power_3"] is not None
                    else "n/a"
                ),
                pass5=(
                    f"{model['pass_at_5']:.1%}"
                    if model["pass_at_5"] is not None
                    else "n/a"
                ),
                pass_power5=(
                    f"{model['pass_power_5']:.1%}"
                    if model["pass_power_5"] is not None
                    else "n/a"
                ),
                pass10=(
                    f"{model['pass_at_10']:.1%}"
                    if model["pass_at_10"] is not None
                    else "n/a"
                ),
                pass_power10=(
                    f"{model['pass_power_10']:.1%}"
                    if model["pass_power_10"] is not None
                    else "n/a"
                ),
                errors=model["errors"],
                calls=model["calls_per_rollout"],
                seconds=model["agent_seconds_p50"],
                prompt=f"{input_tokens:,}" if input_tokens is not None else "n/a",
                output=(f"{output_tokens:,}" if output_tokens is not None else "n/a"),
                e2e_rate=f"{e2e_rate:.1f}" if e2e_rate is not None else "n/a",
                aggregate_rate=(
                    f"{aggregate_rate:.1f}" if aggregate_rate is not None else "n/a"
                ),
                request_rate=(
                    f"{request_rate:.1f}" if request_rate is not None else "n/a"
                ),
                cached=(f"{cached_rate:.1%}" if cached_rate is not None else "n/a"),
                cost=cost_text,
            )
        )
    if any(model["terminal_outcomes"] for model in models):
        lines.extend(
            [
                "",
                "| Model | Terminal outcomes |",
                "| --- | --- |",
            ]
        )
        for model in models:
            outcomes = ", ".join(
                f"{status}: {count}"
                for status, count in model["terminal_outcomes"].items()
            )
            lines.append(f"| {model['model']} | {outcomes or 'n/a'} |")
    if any(model["families"] for model in models):
        lines.extend(
            [
                "",
                "| Model | Family | Scenarios | n | Mean | Strict | Pass@1 [95% CI] | Pass@3 | Pass^3 | Pass@5 | Pass^5 | Pass@10 | Pass^10 |",
                "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
        for model in models:
            for family_id, family in model["families"].items():
                ci95 = family["pass_at_1_ci95"]
                pass_at_1 = f"{family['pass_at_1']:.1%}"
                if ci95 is not None:
                    pass_at_1 += f" [{ci95[0]:.1%}, {ci95[1]:.1%}]"
                lines.append(
                    "| {model} | {family} | {scenarios} | {rollouts} | "
                    "{mean:.3f} | {strict}/{rollouts} | {pass1} | {pass3} | "
                    "{power3} | {pass5} | {power5} | {pass10} | {power10} |".format(
                        model=model["model"],
                        family=family_id,
                        scenarios=family["scenarios"],
                        rollouts=family["rollouts"],
                        mean=family["score_mean"],
                        strict=family["strict_passes"],
                        pass1=pass_at_1,
                        pass3=_format_optional_rate(family["pass_at_3"]),
                        power3=_format_optional_rate(family["pass_power_3"]),
                        pass5=_format_optional_rate(family["pass_at_5"]),
                        power5=_format_optional_rate(family["pass_power_5"]),
                        pass10=_format_optional_rate(family["pass_at_10"]),
                        power10=_format_optional_rate(family["pass_power_10"]),
                    )
                )
    milestone_ids = sorted(
        {milestone_id for model in models for milestone_id in model["milestones"]}
    )
    if milestone_ids:
        lines.extend(
            [
                "",
                "| Model | " + " | ".join(milestone_ids) + " |",
                "| --- | " + " | ".join("---:" for _ in milestone_ids) + " |",
            ]
        )
        for model in models:
            cells = []
            for milestone_id in milestone_ids:
                milestone = model["milestones"].get(milestone_id)
                cells.append(
                    "n/a"
                    if milestone is None
                    else f"{milestone['passed']}/{milestone['total']}"
                )
            lines.append(f"| {model['model']} | " + " | ".join(cells) + " |")
    if any(model["scenarios"] for model in models):
        lines.extend(
            [
                "",
                "| Model | Family | Scenario | n | Mean | Strict | Pass@3 | Pass^3 | Pass@5 | Pass^5 | Pass@10 | Pass^10 |",
                "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
        for model in models:
            for scenario_id, scenario in model["scenarios"].items():
                lines.append(
                    "| {model} | {family} | {scenario_id} | {rollouts} | "
                    "{mean:.3f} | {strict}/{rollouts} | {pass_at_3} | "
                    "{pass_power_3} | {pass_at_5} | {pass_power_5} | "
                    "{pass_at_10} | {pass_power_10} |".format(
                        model=model["model"],
                        family=scenario["family"],
                        scenario_id=scenario_id,
                        rollouts=scenario["rollouts"],
                        mean=scenario["score_mean"],
                        strict=scenario["strict_passes"],
                        pass_at_3=_format_optional_rate(scenario["pass_at_3"]),
                        pass_power_3=_format_optional_rate(
                            scenario["pass_power_3"]
                        ),
                        pass_at_5=_format_optional_rate(scenario["pass_at_5"]),
                        pass_power_5=_format_optional_rate(
                            scenario["pass_power_5"]
                        ),
                        pass_at_10=_format_optional_rate(scenario["pass_at_10"]),
                        pass_power_10=_format_optional_rate(
                            scenario["pass_power_10"]
                        ),
                    )
                )
    dimension_ids = sorted(
        {dimension_id for model in models for dimension_id in model["dimensions"]}
    )
    if dimension_ids:
        lines.extend(
            [
                "",
                "| Model | " + " | ".join(dimension_ids) + " |",
                "| --- | " + " | ".join("---:" for _ in dimension_ids) + " |",
            ]
        )
        for model in models:
            cells = [
                "n/a"
                if (dimension := model["dimensions"].get(dimension_id)) is None
                else f"{dimension['score_mean']:.3f}"
                for dimension_id in dimension_ids
            ]
            lines.append(f"| {model['model']} | " + " | ".join(cells) + " |")
    if any(model["constraints"] for model in models):
        lines.extend(
            [
                "",
                "| Model | Constraint | Severity | Violations |",
                "| --- | --- | --- | ---: |",
            ]
        )
        for model in models:
            for constraint_id, constraint in sorted(model["constraints"].items()):
                lines.append(
                    f"| {model['model']} | {constraint_id} | "
                    f"{constraint['severity']} | {constraint['violations']}/"
                    f"{constraint['total']} |"
                )
    return "\n".join(lines)


def _format_optional_rate(value: float | None) -> str:
    return f"{value:.1%}" if value is not None else "n/a"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Summarize local GSV Verifiers matrix traces."
    )
    parser.add_argument("matrix_dir", type=Path)
    parser.add_argument("--pricing", type=Path)
    parser.add_argument(
        "--scenario",
        type=Path,
        help="Regrade artifacts offline with this fixture, directory, or family.",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    summary = summarize_matrix(
        args.matrix_dir,
        load_pricing(args.pricing),
        load_evaluations(args.scenario),
    )
    if args.output is not None:
        args.output.write_text(json.dumps(summary, indent=2) + "\n")
    print(render_markdown(summary))


if __name__ == "__main__":
    main()
