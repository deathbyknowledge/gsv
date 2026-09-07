"""Deterministic composition and expansion for GSV scenario families."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

_PLACEHOLDER = re.compile(r"\$\{([A-Za-z][A-Za-z0-9_]*)\}")


def load_scenarios(path: Path) -> list[dict[str, Any]]:
    """Load direct scenarios and expand family documents from a file or directory."""
    configured = path.expanduser().resolve()
    paths = sorted(configured.glob("*.json")) if configured.is_dir() else [configured]
    if not paths or any(not item.is_file() for item in paths):
        raise ValueError(f"No GSV scenario documents found at {configured}")

    scenarios: list[dict[str, Any]] = []
    for document_path in paths:
        document = json.loads(document_path.read_text())
        if not isinstance(document, dict):
            raise TypeError(f"GSV scenario document is not an object: {document_path}")
        if document.get("schemaVersion") == 3:
            scenarios.append(document)
        elif document.get("familySchemaVersion") == 1:
            scenarios.extend(expand_family(document, str(document_path)))
        else:
            raise ValueError(
                f"Scenario {document_path} is neither schemaVersion 3 nor "
                "familySchemaVersion 1"
            )

    identifiers = [scenario.get("id") for scenario in scenarios]
    if any(
        not isinstance(identifier, str) or not identifier for identifier in identifiers
    ):
        raise TypeError(f"Expanded scenarios under {configured} require non-empty ids")
    if len(set(identifiers)) != len(identifiers):
        raise ValueError(f"Expanded scenarios under {configured} contain duplicate ids")
    return scenarios


def expand_family(document: dict[str, Any], source: str) -> list[dict[str, Any]]:
    """Compose modules and expand every seeded variant in a family document."""
    family_id = document.get("id")
    base = document.get("base")
    modules = document.get("modules", {})
    variants = document.get("variants")
    if (
        not isinstance(family_id, str)
        or not family_id
        or not isinstance(base, dict)
        or not isinstance(modules, dict)
        or not all(
            isinstance(name, str) and isinstance(value, dict)
            for name, value in modules.items()
        )
        or not isinstance(variants, list)
        or not variants
    ):
        raise TypeError(f"Invalid GSV scenario family: {source}")

    expanded: list[dict[str, Any]] = []
    variant_ids: set[str] = set()
    for variant in variants:
        if not isinstance(variant, dict):
            raise TypeError(f"Invalid variant in GSV scenario family: {source}")
        variant_id = variant.get("id")
        seed = variant.get("seed")
        selected_modules = variant.get("modules", [])
        values = variant.get("values", {})
        overrides = variant.get("overrides", {})
        if (
            not isinstance(variant_id, str)
            or not variant_id
            or variant_id in variant_ids
            or not isinstance(seed, str)
            or not seed
            or not isinstance(selected_modules, list)
            or not all(isinstance(name, str) and name for name in selected_modules)
            or not isinstance(values, dict)
            or not all(isinstance(name, str) and name for name in values)
            or not isinstance(overrides, dict)
        ):
            raise TypeError(f"Invalid variant in GSV scenario family: {source}")
        variant_ids.add(variant_id)

        unknown_modules = [name for name in selected_modules if name not in modules]
        if unknown_modules:
            raise ValueError(
                f"Family {family_id} variant {variant_id} selects unknown module "
                f"{unknown_modules[0]}"
            )
        composed = copy.deepcopy(base)
        for module_name in selected_modules:
            composed = merge_documents(composed, modules[module_name])
        composed = merge_documents(composed, overrides)

        scenario_id = variant.get("scenarioId", f"{family_id}:{variant_id}")
        if not isinstance(scenario_id, str) or not scenario_id:
            raise TypeError(
                f"Family {family_id} variant {variant_id} has invalid scenarioId"
            )
        variables = {
            **values,
            "family_id": family_id,
            "variant_id": variant_id,
            "scenario_id": scenario_id,
            "seed": seed,
        }
        scenario = interpolate(composed, variables, f"{source}#{variant_id}")
        if not isinstance(scenario, dict):
            raise TypeError(
                f"Family {family_id} variant {variant_id} did not produce an object"
            )
        scenario["schemaVersion"] = 3
        scenario["id"] = scenario_id
        scenario["seed"] = seed
        scenario["family"] = family_id
        scenario["tags"] = _family_tags(document, variant, scenario)
        scenario.setdefault("groundTruth", {})
        expanded.append(scenario)
    return expanded


def merge_documents(base: object, addition: object) -> Any:
    """Recursively merge objects, concatenate arrays, and let later scalars win."""
    if isinstance(base, dict) and isinstance(addition, dict):
        merged = copy.deepcopy(base)
        for key, value in addition.items():
            merged[key] = (
                merge_documents(merged[key], value)
                if key in merged
                else copy.deepcopy(value)
            )
        return merged
    if isinstance(base, list) and isinstance(addition, list):
        return copy.deepcopy(base) + copy.deepcopy(addition)
    return copy.deepcopy(addition)


def interpolate(value: object, variables: dict[str, Any], source: str) -> Any:
    """Resolve placeholders recursively; whole-value placeholders preserve JSON type."""
    if isinstance(value, str):
        exact = _PLACEHOLDER.fullmatch(value)
        if exact:
            return copy.deepcopy(_variable(variables, exact.group(1), source))

        def replace(match: re.Match[str]) -> str:
            replacement = _variable(variables, match.group(1), source)
            if isinstance(replacement, str):
                return replacement
            return json.dumps(replacement, sort_keys=True, separators=(",", ":"))

        result = _PLACEHOLDER.sub(replace, value)
        if "${" in result:
            raise ValueError(f"Unresolved placeholder in {source}: {result}")
        return result
    if isinstance(value, list):
        return [interpolate(item, variables, source) for item in value]
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            expanded_key = interpolate(key, variables, source)
            if not isinstance(expanded_key, str):
                raise TypeError(f"Expanded object key is not a string in {source}")
            if expanded_key in result:
                raise ValueError(
                    f"Expansion produced duplicate key {expanded_key} in {source}"
                )
            result[expanded_key] = interpolate(item, variables, source)
        return result
    return copy.deepcopy(value)


def _variable(variables: dict[str, Any], name: str, source: str) -> Any:
    if name not in variables:
        raise ValueError(f"Unknown placeholder {name} in {source}")
    return variables[name]


def _family_tags(
    family: dict[str, Any], variant: dict[str, Any], scenario: dict[str, Any]
) -> list[str]:
    values: list[str] = []
    for source in (
        family.get("tags", []),
        scenario.get("tags", []),
        variant.get("tags", []),
    ):
        if not isinstance(source, list) or not all(
            isinstance(item, str) and item for item in source
        ):
            raise TypeError(f"Family {family['id']} contains invalid tags")
        for item in source:
            if item not in values:
                values.append(item)
    return values
