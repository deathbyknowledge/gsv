"""Offline summaries for GSV Verifiers v1 evaluation matrices."""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any


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


def summarize_matrix(
    matrix_dir: Path,
    pricing: dict[str, dict[str, float]] | None = None,
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
        agent_seconds: list[float] = []
        request_seconds = 0.0
        prompt_tokens = 0
        completion_tokens = 0
        cached_input_tokens = 0
        reasoning_tokens = 0
        call_count = 0
        error_count = 0
        criteria: dict[str, dict[str, Any]] = {}

        for entry in entries:
            envelope = entry["envelope"]
            trace = entry["trace"]
            rewards = trace.get("rewards", {})
            scenario_reward = (
                rewards.get("scenario_outcome", {}) if isinstance(rewards, dict) else {}
            )
            scores.append(
                _number(
                    scenario_reward.get("score")
                    if isinstance(scenario_reward, dict)
                    else None
                )
            )

            timing = trace.get("timing", {})
            agent_timing = timing.get("agent", {}) if isinstance(timing, dict) else {}
            agent_seconds.append(_duration(agent_timing))

            calls = trace.get("calls", [])
            if isinstance(calls, list):
                for call in calls:
                    if not isinstance(call, dict):
                        continue
                    call_count += 1
                    request_seconds += _duration(call.get("time"))
                    usage = call.get("usage", {})
                    if not isinstance(usage, dict):
                        continue
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

            rubric = trace.get("info", {}).get("gsv_rubric", [])
            if isinstance(rubric, list):
                for criterion in rubric:
                    if not isinstance(criterion, dict):
                        continue
                    criterion_id = criterion.get("id")
                    if not isinstance(criterion_id, str):
                        continue
                    summary = criteria.setdefault(
                        criterion_id,
                        {
                            "description": criterion.get("description", ""),
                            "passed": 0,
                            "total": 0,
                        },
                    )
                    summary["total"] += 1
                    summary["passed"] += int(criterion.get("passed") is True)

        count = len(entries)
        total_agent_seconds = sum(agent_seconds)
        price = prices.get(model_id)
        estimated_cost = None
        if price is not None:
            estimated_cost = (
                prompt_tokens * price["input_usd_per_mtok"]
                + completion_tokens * price["output_usd_per_mtok"]
            ) / 1_000_000
        for criterion in criteria.values():
            total = criterion["total"]
            criterion["rate"] = criterion["passed"] / total if total else 0.0

        models.append(
            {
                "model": model_id,
                "rollouts": count,
                "score_mean": statistics.fmean(scores) if scores else 0.0,
                "score_median": statistics.median(scores) if scores else 0.0,
                "full_passes": sum(score >= 1.0 for score in scores),
                "errors": error_count,
                "calls": call_count,
                "calls_per_rollout": call_count / count if count else 0.0,
                "agent_seconds": total_agent_seconds,
                "agent_seconds_p50": _percentile(agent_seconds, 0.5),
                "agent_seconds_p95": _percentile(agent_seconds, 0.95),
                "request_seconds": request_seconds,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "cached_input_tokens": cached_input_tokens,
                "reasoning_tokens": reasoning_tokens,
                "cached_input_rate": (
                    cached_input_tokens / prompt_tokens if prompt_tokens else 0.0
                ),
                "observed_output_tokens_per_second": (
                    completion_tokens / total_agent_seconds
                    if total_agent_seconds
                    else 0.0
                ),
                "request_output_tokens_per_second": (
                    completion_tokens / request_seconds if request_seconds else 0.0
                ),
                "listed_cost_usd": estimated_cost,
                "criteria": criteria,
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
        "| Model | n | Mean | Median | Full | Errors | Calls/n | P50 s | Prompt tok | Output tok | Output tok/s | Cached | Listed cost |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for model in models:
        cost = model["listed_cost_usd"]
        cost_text = f"${cost:.4f}" if cost is not None else "n/a"
        lines.append(
            "| {model} | {rollouts} | {mean:.3f} | {median:.3f} | "
            "{full}/{rollouts} | {errors} | {calls:.1f} | {seconds:.1f} | "
            "{prompt:,} | {output:,} | {rate:.1f} | {cached:.1%} | {cost} |".format(
                model=model["model"],
                rollouts=model["rollouts"],
                mean=model["score_mean"],
                median=model["score_median"],
                full=model["full_passes"],
                errors=model["errors"],
                calls=model["calls_per_rollout"],
                seconds=model["agent_seconds_p50"],
                prompt=model["prompt_tokens"],
                output=model["completion_tokens"],
                rate=model["observed_output_tokens_per_second"],
                cached=model["cached_input_rate"],
                cost=cost_text,
            )
        )
    criterion_ids = sorted(
        {criterion_id for model in models for criterion_id in model["criteria"]}
    )
    if criterion_ids:
        lines.extend(
            [
                "",
                "| Model | " + " | ".join(criterion_ids) + " |",
                "| --- | " + " | ".join("---:" for _ in criterion_ids) + " |",
            ]
        )
        for model in models:
            cells = []
            for criterion_id in criterion_ids:
                criterion = model["criteria"].get(criterion_id)
                cells.append(
                    "n/a"
                    if criterion is None
                    else f"{criterion['passed']}/{criterion['total']}"
                )
            lines.append(f"| {model['model']} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Summarize local GSV Verifiers matrix traces."
    )
    parser.add_argument("matrix_dir", type=Path)
    parser.add_argument("--pricing", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    summary = summarize_matrix(args.matrix_dir, load_pricing(args.pricing))
    if args.output is not None:
        args.output.write_text(json.dumps(summary, indent=2) + "\n")
    print(render_markdown(summary))


if __name__ == "__main__":
    main()
