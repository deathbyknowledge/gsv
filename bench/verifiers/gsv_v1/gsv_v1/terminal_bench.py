"""Terminal-Bench task adaptation through a GSV Docker-backed target."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
import tarfile
import tempfile
from pathlib import Path
from typing import Any, Literal

import verifiers.v1 as vf
import yaml

_BUILD_LOCKS: dict[str, asyncio.Lock] = {}
_TARGETS: dict[str, tuple[Literal["docker", "prime"], str]] = {}
_CACHE_ROOT = Path.home() / ".cache" / "gsv" / "terminal-bench"
_EXCLUDED_CONTEXT_NAMES = {
    "docker-compose.yaml",
    "run-tests.sh",
    "solution.sh",
    "task.yaml",
    "tests",
}


def load_terminal_bench_scenarios(
    root: Path, selected: list[str] | None
) -> list[tuple[dict[str, Any], Path]]:
    root = root.expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Terminal-Bench path does not exist: {root}")
    selected_set = set(selected or [])
    task_dirs = [
        path.parent
        for path in sorted(root.rglob("task.yaml"))
        if not selected_set or path.parent.name in selected_set
    ]
    if selected_set:
        found = {path.name for path in task_dirs}
        missing = sorted(selected_set - found)
        if missing:
            raise ValueError(f"Terminal-Bench tasks not found: {', '.join(missing)}")
    if not task_dirs:
        raise ValueError(f"No Terminal-Bench tasks found under {root}")
    return [(scenario_from_task(path), path) for path in task_dirs]


def scenario_from_task(task_dir: Path) -> dict[str, Any]:
    document = yaml.safe_load((task_dir / "task.yaml").read_text())
    if not isinstance(document, dict) or not isinstance(
        document.get("instruction"), str
    ):
        raise TypeError(f"Invalid Terminal-Bench task: {task_dir}")
    if document.get("parser_name") != "pytest":
        raise ValueError(
            f"Terminal-Bench task {task_dir.name} uses unsupported parser "
            f"{document.get('parser_name')!r}"
        )
    if not (task_dir / "Dockerfile").is_file():
        raise ValueError(f"Terminal-Bench task has no Dockerfile: {task_dir.name}")
    if not (task_dir / "run-tests.sh").is_file() or not (task_dir / "tests").is_dir():
        raise ValueError(f"Terminal-Bench task has no pytest verifier: {task_dir.name}")
    validate_compose_compatibility(task_dir)

    digest = task_digest(task_dir)
    return {
        "schemaVersion": 3,
        "id": f"terminal-bench:{task_dir.name}",
        "seed": digest,
        "description": (
            "An upstream Terminal-Bench task executed through one GSV target and "
            "graded by its unchanged pytest verifier."
        ),
        "systemPrompt": (
            "You are Ship operating an isolated Terminal-Bench environment through "
            "GSV. The target named terminal is the task machine. Use Shell with "
            "target terminal for all task work. Finish the Process with yield after "
            "the requested artifact is complete."
        ),
        "prompt": document["instruction"].strip(),
        "entryProcessId": "ship",
        "world": {
            "runtime": {"now": "2026-09-02T00:00:00.000Z", "timezone": "UTC"},
            "processes": [
                {
                    "id": "ship",
                    "role": "ship",
                    "uid": 1000,
                    "ownerUid": 1000,
                    "username": "ship",
                    "gids": [1000],
                    "capabilities": ["shell.exec", "sys.device.list"],
                }
            ],
            "delegates": [],
            "adapters": [],
        },
        "components": {
            "targets": [
                {
                    "id": "terminal",
                    "kind": "server",
                    "driver": "docker-exec",
                    "driverConfig": {
                        "container": "gsv-terminal-placeholder",
                        "workdir": "/app",
                        "timeoutMs": 300_000,
                    },
                    "ownerUid": 1000,
                    "accessGids": [1000],
                    "label": f"Terminal-Bench: {task_dir.name}",
                    "description": "The isolated upstream Terminal-Bench task machine.",
                    "platform": "linux",
                    "version": digest[:12],
                    "online": True,
                    "implements": ["shell.exec"],
                    "state": {"source": "terminal-bench", "task": task_dir.name},
                }
            ],
            "transitions": [],
            "events": [],
        },
        "evaluation": {
            "milestones": [
                {
                    "id": "upstream-verifier",
                    "description": "The unchanged Terminal-Bench verifier passes.",
                    "dimension": "outcome",
                    "weight": 1.0,
                    "requires": [],
                    "requiredForStrict": True,
                    "predicates": [
                        {
                            "type": "match",
                            "path": "/external/terminalBench/reward",
                            "mode": "equals",
                            "value": 1.0,
                        }
                    ],
                }
            ],
            "constraints": [],
        },
        "maxTurns": 50,
        "maxRuns": 1,
    }


async def start_terminal_bench(
    trace: vf.Trace,
    runtime: vf.Runtime,
    scenario: dict[str, Any],
    task_dir: Path,
    backend: Literal["auto", "docker", "prime"],
) -> dict[str, Any]:
    digest = scenario["seed"]
    selected = await select_backend(runtime, backend)
    if selected == "docker":
        target = await start_docker_target(trace, runtime, task_dir, digest)
        driver = "docker-exec"
        driver_config = {"container": target, "workdir": "/app", "timeoutMs": 300_000}
    else:
        target = await start_prime_target(trace, runtime, task_dir, digest)
        driver = "prime-sandbox"
        driver_config = {"sandbox": target, "workdir": "/app", "timeoutMs": 300_000}
    _TARGETS[trace.id] = (selected, target)
    materialized = json.loads(json.dumps(scenario))
    materialized["components"]["targets"][0]["driver"] = driver
    materialized["components"]["targets"][0]["driverConfig"] = driver_config
    return materialized


async def grade_terminal_bench(
    trace: vf.Trace, runtime: vf.Runtime, task_dir: Path
) -> dict[str, Any]:
    target = _TARGETS.pop(trace.id, None)
    if target is None:
        raise RuntimeError("Terminal-Bench target was not started")
    backend, target_id = target
    try:
        result = (
            await grade_docker_target(runtime, target_id, task_dir)
            if backend == "docker"
            else await grade_prime_target(runtime, target_id, task_dir)
        )
        output = (result.stdout + result.stderr).strip()
        return {
            "reward": 1.0 if result.exit_code == 0 else 0.0,
            "task": task_dir.name,
            "testExitCode": result.exit_code,
            "testOutputTail": output[-4_000:],
        }
    finally:
        await stop_target(runtime, backend, target_id)


async def stop_terminal_bench(trace: vf.Trace, runtime: vf.Runtime) -> None:
    target = _TARGETS.pop(trace.id, None)
    if target is not None:
        await stop_target(runtime, *target)


async def stop_target(
    runtime: vf.Runtime, backend: Literal["docker", "prime"], target_id: str
) -> None:
    if backend == "docker":
        await runtime.run(["docker", "rm", "--force", target_id], {})
    else:
        await runtime.run(
            ["prime", "--plain", "sandbox", "delete", "--yes", target_id], {}
        )


async def select_backend(
    runtime: vf.Runtime, backend: Literal["auto", "docker", "prime"]
) -> Literal["docker", "prime"]:
    if backend != "auto":
        return backend
    docker = await runtime.run(
        ["docker", "version", "--format", "{{.Server.Version}}"], {}
    )
    return "docker" if docker.exit_code == 0 else "prime"


async def start_docker_target(
    trace: vf.Trace, runtime: vf.Runtime, task_dir: Path, digest: str
) -> str:
    image = f"gsv-terminal-bench:{digest[:16]}"
    lock = _BUILD_LOCKS.setdefault("docker:" + image, asyncio.Lock())
    async with lock:
        inspect = await runtime.run(["docker", "image", "inspect", image], {})
        if inspect.exit_code:
            context = await asyncio.to_thread(prepare_build_context, task_dir, digest)
            built = await runtime.run(
                ["docker", "build", "--quiet", "--tag", image, str(context)], {}
            )
            require_success(built, "Terminal-Bench image build failed")
    container = "gsv-tbench-" + trace.id[:24]
    await runtime.run(["docker", "rm", "--force", container], {})
    started = await runtime.run(
        [
            "docker",
            "run",
            "--detach",
            "--rm",
            "--name",
            container,
            "--label",
            "gsv.benchmark=terminal-bench",
            "--entrypoint",
            "sh",
            image,
            "-lc",
            "while :; do sleep 3600; done",
        ],
        {},
    )
    require_success(started, "Terminal-Bench container failed to start")
    return container


async def start_prime_target(
    trace: vf.Trace, runtime: vf.Runtime, task_dir: Path, digest: str
) -> str:
    image_name = "gsv-terminal-" + task_dir.name.replace("_", "-")
    image_tag = digest[:16]
    lock = _BUILD_LOCKS.setdefault(f"prime:{image_name}:{image_tag}", asyncio.Lock())
    async with lock:
        image = await find_prime_image(runtime, image_name, image_tag)
        if image is None:
            context = await asyncio.to_thread(prepare_build_context, task_dir, digest)
            pushed = await runtime.run(
                [
                    "prime",
                    "--plain",
                    "images",
                    "push",
                    f"{image_name}:{image_tag}",
                    "--context",
                    str(context),
                    "--private",
                ],
                {},
            )
            require_success(pushed, "Terminal-Bench Prime image build failed")
            image = await wait_for_prime_image(runtime, image_name, image_tag)
            if image is None:
                raise RuntimeError(
                    "Prime image build completed without a discoverable image"
                )
    name = "gsv-tbench-" + trace.id[:16]
    created = await runtime.run(
        [
            "prime",
            "--plain",
            "sandbox",
            "create",
            "--container",
            "--yes",
            "--name",
            name,
            "--cpu-cores",
            "2",
            "--memory-gb",
            "4",
            "--disk-size-gb",
            "10",
            "--timeout-minutes",
            "30",
            "--idle-timeout-minutes",
            "15",
            "--label",
            "gsv-terminal-bench",
            image,
            "sleep",
            "infinity",
        ],
        {},
    )
    require_success(created, "Terminal-Bench Prime sandbox failed to start")
    matched = re.search(
        r"Successfully created sandbox ([A-Za-z0-9_-]+)", created.stdout
    )
    if matched is None:
        raise RuntimeError(
            "Prime sandbox creation returned no id: " + created.stdout.strip()[-500:]
        )
    sandbox_id = matched.group(1)
    try:
        await wait_for_prime_sandbox(runtime, sandbox_id)
    except (Exception, asyncio.CancelledError):
        await stop_target(runtime, "prime", sandbox_id)
        raise
    return sandbox_id


def validate_compose_compatibility(task_dir: Path) -> None:
    compose_path = task_dir / "docker-compose.yaml"
    if not compose_path.is_file():
        return
    document = yaml.safe_load(compose_path.read_text())
    services = document.get("services") if isinstance(document, dict) else None
    if not isinstance(services, dict) or len(services) != 1:
        count = len(services) if isinstance(services, dict) else 0
        raise ValueError(
            f"Terminal-Bench task {task_dir.name} requires {count} compose services; "
            "the GSV adapter currently supports one"
        )
    service = next(iter(services.values()))
    if not isinstance(service, dict):
        raise TypeError(f"Invalid Terminal-Bench compose service: {task_dir.name}")
    supported = {
        "build",
        "container_name",
        "working_dir",
    }
    unsupported = sorted(set(service) - supported)
    if unsupported:
        raise ValueError(
            f"Terminal-Bench task {task_dir.name} requires unsupported compose "
            f"options: {', '.join(unsupported)}"
        )
    build = service.get("build")
    if isinstance(build, str):
        context = build
        dockerfile = "Dockerfile"
    elif isinstance(build, dict):
        unsupported_build = sorted(set(build) - {"context", "dockerfile"})
        if unsupported_build:
            raise ValueError(
                f"Terminal-Bench task {task_dir.name} requires unsupported compose "
                f"build options: {', '.join(unsupported_build)}"
            )
        context = build.get("context", ".")
        dockerfile = build.get("dockerfile", "Dockerfile")
    else:
        raise TypeError(
            f"Terminal-Bench task {task_dir.name} has no supported compose build"
        )
    if context not in {".", ""} or dockerfile != "Dockerfile":
        raise ValueError(
            f"Terminal-Bench task {task_dir.name} requires a non-default build "
            "context; the GSV adapter currently supports the task root Dockerfile"
        )
    if service.get("working_dir", "/app") != "/app":
        raise ValueError(
            f"Terminal-Bench task {task_dir.name} requires a working directory "
            "other than /app"
        )


async def find_prime_image(
    runtime: vf.Runtime, image_name: str, image_tag: str
) -> str | None:
    result = await runtime.run(
        [
            "prime",
            "--plain",
            "images",
            "list",
            "--search",
            image_name,
            "--output",
            "json",
        ],
        {},
    )
    if result.exit_code:
        return None
    document = json.loads(result.stdout)
    for image in document.get("data", []):
        if (
            image.get("imageName") == image_name
            and image.get("imageTag") == image_tag
            and image.get("status") == "COMPLETED"
        ):
            return image.get("displayRef") or image.get("fullImagePath")
    return None


async def wait_for_prime_image(
    runtime: vf.Runtime, image_name: str, image_tag: str
) -> str | None:
    for _ in range(180):
        image = await find_prime_image(runtime, image_name, image_tag)
        if image is not None:
            return image
        await asyncio.sleep(5)
    return None


async def wait_for_prime_sandbox(runtime: vf.Runtime, sandbox: str) -> None:
    for _ in range(180):
        result = await runtime.run(
            [
                "prime",
                "--plain",
                "sandbox",
                "get",
                sandbox,
                "--output",
                "json",
            ],
            {},
        )
        require_success(result, "Could not inspect Terminal-Bench Prime sandbox")
        status = json.loads(result.stdout).get("status")
        if status == "RUNNING":
            return
        if status in {"ERROR", "FAILED", "STOPPED", "TERMINATED"}:
            raise RuntimeError(f"Terminal-Bench Prime sandbox entered {status}")
        await asyncio.sleep(1)
    raise RuntimeError("Terminal-Bench Prime sandbox did not start within 180 seconds")


async def grade_docker_target(
    runtime: vf.Runtime, container: str, task_dir: Path
) -> Any:
    for source, destination in (
        (task_dir / "tests", f"{container}:/tests"),
        (task_dir / "run-tests.sh", f"{container}:/run-tests.sh"),
    ):
        copied = await runtime.run(["docker", "cp", str(source), destination], {})
        require_success(copied, "Terminal-Bench verifier staging failed")
    return await runtime.run(
        [
            "docker",
            "exec",
            "--env",
            "TEST_DIR=/tests",
            "--workdir",
            "/app",
            container,
            "bash",
            "/run-tests.sh",
        ],
        {},
    )


async def grade_prime_target(runtime: vf.Runtime, sandbox: str, task_dir: Path) -> Any:
    archive = await asyncio.to_thread(make_verifier_archive, task_dir)
    uploaded = await runtime.run(
        [
            "prime",
            "--plain",
            "sandbox",
            "upload",
            sandbox,
            str(archive),
            "/tmp/gsv-terminal-verifier.tgz",
        ],
        {},
    )
    require_success(uploaded, "Terminal-Bench verifier upload failed")
    staged = await runtime.run(
        prime_run_command(
            sandbox,
            "/app",
            "mkdir -p /tests && tar -xzf /tmp/gsv-terminal-verifier.tgz -C /",
        ),
        {},
    )
    require_success(staged, "Terminal-Bench verifier staging failed")
    return await runtime.run(
        [
            "prime",
            "--plain",
            "sandbox",
            "run",
            sandbox,
            "--working-dir",
            "/app",
            "--env",
            "TEST_DIR=/tests",
            "--timeout",
            "600",
            "--",
            "bash",
            "/run-tests.sh",
        ],
        {},
    )


def prime_run_command(sandbox: str, workdir: str, command: str) -> list[str]:
    return [
        "prime",
        "--plain",
        "sandbox",
        "run",
        sandbox,
        "--working-dir",
        workdir,
        "--timeout",
        "120",
        "--",
        "sh",
        "-lc",
        command,
    ]


def make_verifier_archive(task_dir: Path) -> Path:
    archive_dir = _CACHE_ROOT / "verifiers"
    archive_dir.mkdir(parents=True, exist_ok=True)
    archive = archive_dir / f"{task_digest(task_dir)}.tgz"
    if archive.is_file():
        return archive
    with tempfile.NamedTemporaryFile(
        dir=archive_dir, suffix=".tgz", delete=False
    ) as file:
        temporary = Path(file.name)
    try:
        with tarfile.open(temporary, "w:gz") as tar:
            tar.add(task_dir / "tests", arcname="tests")
            tar.add(task_dir / "run-tests.sh", arcname="run-tests.sh")
        temporary.rename(archive)
    finally:
        temporary.unlink(missing_ok=True)
    return archive


def require_success(result: Any, message: str) -> None:
    if result.exit_code:
        raise RuntimeError(
            message + ": " + (result.stderr or result.stdout).strip()[-2_000:]
        )


def task_digest(task_dir: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(task_dir.rglob("*")):
        if not path.is_file() or "solution.sh" in path.parts:
            continue
        digest.update(path.relative_to(task_dir).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def prepare_build_context(task_dir: Path, digest: str) -> Path:
    context = _CACHE_ROOT / "contexts" / digest
    if context.is_dir():
        return context
    context.parent.mkdir(parents=True, exist_ok=True)
    temporary = context.with_name(context.name + ".tmp")
    shutil.rmtree(temporary, ignore_errors=True)
    shutil.copytree(
        task_dir,
        temporary,
        ignore=shutil.ignore_patterns(*_EXCLUDED_CONTEXT_NAMES),
    )
    try:
        temporary.rename(context)
    except OSError:
        if not context.is_dir():
            raise
        shutil.rmtree(temporary, ignore_errors=True)
    return context
