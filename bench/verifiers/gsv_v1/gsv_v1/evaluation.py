"""Deterministic, path-independent scoring for GSV scenario artifacts."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

_MISSING = object()


def validate_evaluation(evaluation: object, source: str) -> dict[str, Any]:
    if not isinstance(evaluation, dict):
        raise TypeError(f"Scenario {source} has no evaluation object")
    milestones = evaluation.get("milestones")
    constraints = evaluation.get("constraints", [])
    if not isinstance(milestones, list) or not milestones:
        raise TypeError(f"Scenario {source} has no evaluation milestones")
    if not isinstance(constraints, list):
        raise TypeError(f"Scenario {source} has invalid evaluation constraints")

    milestone_ids: set[str] = set()
    requirements: dict[str, list[str]] = {}
    for milestone in milestones:
        if not isinstance(milestone, dict):
            raise TypeError(f"Scenario {source} has an invalid milestone")
        milestone_id = milestone.get("id")
        required = milestone.get("requires", [])
        predicates = milestone.get("predicates")
        if (
            not isinstance(milestone_id, str)
            or not milestone_id
            or milestone_id in milestone_ids
            or not isinstance(milestone.get("description"), str)
            or not isinstance(milestone.get("dimension"), str)
            or not milestone["dimension"]
            or isinstance(milestone.get("weight"), bool)
            or not isinstance(milestone.get("weight"), int | float)
            or milestone["weight"] <= 0
            or not isinstance(required, list)
            or not all(isinstance(item, str) and item for item in required)
            or not isinstance(milestone.get("requiredForStrict", True), bool)
            or not isinstance(predicates, list)
            or not predicates
        ):
            raise TypeError(f"Scenario {source} has an invalid milestone")
        for predicate in predicates:
            validate_predicate(predicate, source)
        milestone_ids.add(milestone_id)
        requirements[milestone_id] = required

    for milestone_id, required in requirements.items():
        unknown = [item for item in required if item not in milestone_ids]
        if unknown:
            raise ValueError(
                f"Scenario {source} milestone {milestone_id} requires unknown "
                f"milestone {unknown[0]}"
            )
    _require_acyclic(requirements, source)

    constraint_ids: set[str] = set()
    for constraint in constraints:
        if not isinstance(constraint, dict):
            raise TypeError(f"Scenario {source} has an invalid constraint")
        constraint_id = constraint.get("id")
        if (
            not isinstance(constraint_id, str)
            or not constraint_id
            or constraint_id in constraint_ids
            or not isinstance(constraint.get("description"), str)
            or constraint.get("severity") not in {"hard", "advisory"}
        ):
            raise TypeError(f"Scenario {source} has an invalid constraint")
        validate_predicate(constraint.get("predicate"), source)
        constraint_ids.add(constraint_id)
    return evaluation


def validate_predicate(predicate: object, source: str) -> None:
    if not isinstance(predicate, dict):
        raise TypeError(f"Scenario {source} has an invalid evaluation predicate")
    predicate_type = predicate.get("type")
    if predicate_type == "match":
        if (
            not _valid_path(predicate.get("path"))
            or predicate.get("mode", "subset") not in {"equals", "subset"}
            or "value" not in predicate
        ):
            raise TypeError(f"Scenario {source} has an invalid match predicate")
        return
    if predicate_type == "count":
        minimum = predicate.get("min")
        maximum = predicate.get("max")
        if (
            not _valid_path(predicate.get("path"))
            or (minimum is None and maximum is None)
            or (minimum is not None and not _is_nonnegative_int(minimum))
            or (maximum is not None and not _is_nonnegative_int(maximum))
            or (
                isinstance(minimum, int)
                and isinstance(maximum, int)
                and minimum > maximum
            )
        ):
            raise TypeError(f"Scenario {source} has an invalid count predicate")
        return
    if predicate_type == "order":
        if (
            not _valid_path(predicate.get("path"))
            or "before" not in predicate
            or "after" not in predicate
        ):
            raise TypeError(f"Scenario {source} has an invalid order predicate")
        return
    if predicate_type == "sequence":
        items = predicate.get("items")
        if (
            not _valid_path(predicate.get("path"))
            or not isinstance(items, list)
            or len(items) < 2
        ):
            raise TypeError(f"Scenario {source} has an invalid sequence predicate")
        return
    if predicate_type in {"all", "any"}:
        children = predicate.get("predicates")
        if not isinstance(children, list) or not children:
            raise TypeError(f"Scenario {source} has an invalid boolean predicate")
        for child in children:
            validate_predicate(child, source)
        return
    if predicate_type == "not":
        validate_predicate(predicate.get("predicate"), source)
        return
    raise TypeError(f"Scenario {source} has an unknown evaluation predicate")


def evaluate_scenario(
    evaluation: dict[str, Any],
    artifact: dict[str, Any],
    external: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    root = {**artifact, "external": dict(external or {})}
    milestones_by_id = {
        milestone["id"]: milestone for milestone in evaluation["milestones"]
    }
    results_by_id: dict[str, dict[str, Any]] = {}

    def score_milestone(milestone_id: str) -> dict[str, Any]:
        existing = results_by_id.get(milestone_id)
        if existing is not None:
            return existing
        milestone = milestones_by_id[milestone_id]
        dependencies = [
            score_milestone(required) for required in milestone.get("requires", [])
        ]
        predicate_results = [
            evaluate_predicate(root, predicate) for predicate in milestone["predicates"]
        ]
        intrinsic_passed = all(item["passed"] for item in predicate_results)
        passed = intrinsic_passed and all(item["passed"] for item in dependencies)
        result = {
            "id": milestone_id,
            "description": milestone["description"],
            "dimension": milestone["dimension"],
            "weight": float(milestone["weight"]),
            "requires": list(milestone.get("requires", [])),
            "required_for_strict": milestone.get("requiredForStrict", True),
            "intrinsic_passed": intrinsic_passed,
            "passed": passed,
            "predicates": predicate_results,
        }
        results_by_id[milestone_id] = result
        return result

    milestones = [score_milestone(item["id"]) for item in evaluation["milestones"]]
    constraints = []
    for constraint in evaluation.get("constraints", []):
        predicate = evaluate_predicate(root, constraint["predicate"])
        constraints.append(
            {
                "id": constraint["id"],
                "description": constraint["description"],
                "severity": constraint["severity"],
                "passed": predicate["passed"],
                "predicate": predicate,
            }
        )

    total_weight = sum(item["weight"] for item in milestones)
    earned_weight = sum(item["weight"] for item in milestones if item["passed"])
    raw_score = earned_weight / total_weight if total_weight else 0.0
    hard_constraints_passed = all(
        item["passed"] for item in constraints if item["severity"] == "hard"
    )
    strict_pass = hard_constraints_passed and all(
        item["passed"] for item in milestones if item["required_for_strict"]
    )

    dimensions: dict[str, dict[str, float | int]] = {}
    for milestone in milestones:
        dimension = dimensions.setdefault(
            milestone["dimension"], {"earned": 0.0, "weight": 0.0, "score": 0.0}
        )
        dimension["weight"] += milestone["weight"]
        if milestone["passed"]:
            dimension["earned"] += milestone["weight"]
    for dimension in dimensions.values():
        weight = float(dimension["weight"])
        dimension["score"] = float(dimension["earned"]) / weight if weight else 0.0

    return {
        "raw_score": raw_score,
        "reward_score": raw_score if hard_constraints_passed else 0.0,
        "strict_pass": strict_pass,
        "hard_constraints_passed": hard_constraints_passed,
        "milestones": milestones,
        "constraints": constraints,
        "dimensions": dimensions,
    }


def evaluate_predicate(root: object, predicate: dict[str, Any]) -> dict[str, Any]:
    predicate_type = predicate["type"]
    if predicate_type == "match":
        actual = resolve_pointer(root, predicate["path"])
        mode = predicate.get("mode", "subset")
        passed = actual is not _MISSING and (
            json_equal(actual, predicate["value"])
            if mode == "equals"
            else matches_subset(actual, predicate["value"])
        )
        return {"type": predicate_type, "path": predicate["path"], "passed": passed}
    if predicate_type == "count":
        actual = resolve_pointer(root, predicate["path"])
        where = predicate.get("where", _MISSING)
        count = (
            sum(where is _MISSING or matches_subset(item, where) for item in actual)
            if isinstance(actual, list)
            else 0
        )
        minimum = predicate.get("min")
        maximum = predicate.get("max")
        passed = (
            isinstance(actual, list)
            and (minimum is None or count >= minimum)
            and (maximum is None or count <= maximum)
        )
        return {
            "type": predicate_type,
            "path": predicate["path"],
            "count": count,
            "passed": passed,
        }
    if predicate_type == "order":
        actual = resolve_pointer(root, predicate["path"])
        before = []
        after = []
        if isinstance(actual, list):
            before = [
                index
                for index, item in enumerate(actual)
                if matches_subset(item, predicate["before"])
            ]
            after = [
                index
                for index, item in enumerate(actual)
                if matches_subset(item, predicate["after"])
            ]
        return {
            "type": predicate_type,
            "path": predicate["path"],
            "passed": any(left < right for left in before for right in after),
        }
    if predicate_type == "sequence":
        actual = resolve_pointer(root, predicate["path"])
        cursor = 0
        matched_indices: list[int] = []
        if isinstance(actual, list):
            for expected in predicate["items"]:
                match = next(
                    (
                        index
                        for index in range(cursor, len(actual))
                        if matches_subset(actual[index], expected)
                    ),
                    None,
                )
                if match is None:
                    break
                matched_indices.append(match)
                cursor = match + 1
        return {
            "type": predicate_type,
            "path": predicate["path"],
            "matched": len(matched_indices),
            "passed": len(matched_indices) == len(predicate["items"]),
        }
    if predicate_type in {"all", "any"}:
        children = [
            evaluate_predicate(root, child) for child in predicate["predicates"]
        ]
        passed = (
            all(item["passed"] for item in children)
            if predicate_type == "all"
            else any(item["passed"] for item in children)
        )
        return {"type": predicate_type, "passed": passed, "predicates": children}
    if predicate_type == "not":
        child = evaluate_predicate(root, predicate["predicate"])
        return {
            "type": predicate_type,
            "passed": not child["passed"],
            "predicate": child,
        }
    raise ValueError(f"Unknown evaluation predicate: {predicate_type}")


def resolve_pointer(value: object, pointer: str) -> object:
    if pointer == "":
        return value
    if not pointer.startswith("/"):
        return _MISSING
    current = value
    for raw in pointer[1:].split("/"):
        part = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            if part not in current:
                return _MISSING
            current = current[part]
            continue
        if isinstance(current, list) and part.isdigit():
            index = int(part)
            if index >= len(current):
                return _MISSING
            current = current[index]
            continue
        return _MISSING
    return current


def matches_subset(actual: object, expected: object) -> bool:
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and matches_subset(actual[key], item)
            for key, item in expected.items()
        )
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(expected) > len(actual):
            return False
        return _match_list_items(actual, expected, set())
    return json_equal(actual, expected)


def _match_list_items(
    actual: list[object], expected: list[object], used: set[int], index: int = 0
) -> bool:
    if index == len(expected):
        return True
    for actual_index, item in enumerate(actual):
        if actual_index in used or not matches_subset(item, expected[index]):
            continue
        used.add(actual_index)
        if _match_list_items(actual, expected, used, index + 1):
            return True
        used.remove(actual_index)
    return False


def json_equal(actual: object, expected: object) -> bool:
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(actual) is type(expected) and actual == expected
    if isinstance(expected, dict):
        return (
            isinstance(actual, dict)
            and actual.keys() == expected.keys()
            and all(json_equal(actual[key], item) for key, item in expected.items())
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(
                json_equal(left, right)
                for left, right in zip(actual, expected, strict=True)
            )
        )
    return actual == expected


def _require_acyclic(requirements: dict[str, list[str]], source: str) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(milestone_id: str) -> None:
        if milestone_id in visited:
            return
        if milestone_id in visiting:
            raise ValueError(
                f"Scenario {source} has a milestone dependency cycle at {milestone_id}"
            )
        visiting.add(milestone_id)
        for required in requirements[milestone_id]:
            visit(required)
        visiting.remove(milestone_id)
        visited.add(milestone_id)

    for milestone_id in requirements:
        visit(milestone_id)


def _valid_path(value: object) -> bool:
    return isinstance(value, str) and (value == "" or value.startswith("/"))


def _is_nonnegative_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0
