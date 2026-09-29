"""Generate exact-model LiteRT references and optional XNNPACK CPU timings."""

import argparse
import importlib.metadata
import json
import time
from pathlib import Path

import numpy as np
from ai_edge_litert.interpreter import Interpreter

ROOT = Path(__file__).resolve().parents[2]
SHAPE = (1, 224, 224, 3)


def model_goldens(directory):
    """Refresh the small, synthetic regression corpus used by Rust tests."""
    assert importlib.metadata.version("ai-edge-litert") == "2.2.0"
    directory.mkdir(parents=True, exist_ok=True)
    for name, side in (("hand_detector", 192), ("hand_landmarks_detector", 224)):
        interpreter = Interpreter(
            model_path=str(ROOT / f"host/helpers/gestures/models/{name}.tflite"),
            num_threads=1,
        )
        interpreter.allocate_tensors()
        data = (np.arange(side * side * 3) % 256).astype(np.float32) / np.float32(255)
        interpreter.set_tensor(
            interpreter.get_input_details()[0]["index"], data.reshape(1, side, side, 3)
        )
        interpreter.invoke()
        output = np.concatenate([
            interpreter.get_tensor(tensor["index"]).ravel()
            for tensor in interpreter.get_output_details()
        ])
        assert np.isfinite(output).all()
        output.astype("<f4").tofile(directory / f"{name}.expected.f32")


def references(directory, benchmark):
    directory.mkdir(parents=True, exist_ok=True)
    for name, data in (
        ("sample", np.random.default_rng(42).uniform(0, 1, SHAPE)),
        ("random43", np.random.default_rng(43).uniform(0, 1, SHAPE)),
        ("zeros", np.zeros(SHAPE)),
        ("ones", np.ones(SHAPE)),
        (
            "checker",
            np.broadcast_to(
                (np.indices(SHAPE[1:3]).sum(axis=0) % 2)[None, :, :, None], SHAPE
            ),
        ),
    ):
        data.astype("<f4").tofile(directory / f"{name}.input.f32")
    results = []
    for threads in (1, 2, 4) if benchmark else (1,):
        started = time.perf_counter()
        interpreter = Interpreter(
            model_path=str(
                ROOT / "host/helpers/gestures/models/hand_landmarks_detector.tflite"
            ),
            num_threads=threads,
        )
        interpreter.allocate_tensors()
        load_ms = (time.perf_counter() - started) * 1000
        inp = interpreter.get_input_details()[0]["index"]
        outputs = [o["index"] for o in interpreter.get_output_details()]
        if threads == 1:
            for path in sorted(directory.glob("*.input.f32")):
                data = np.fromfile(path, dtype="<f4").reshape(SHAPE)
                interpreter.set_tensor(inp, data)
                interpreter.invoke()
                actual = np.concatenate(
                    [interpreter.get_tensor(o).ravel() for o in outputs]
                )
                assert np.isfinite(actual).all()
                actual.astype("<f4").tofile(
                    path.with_name(path.name.replace(".input.f32", ".expected.f32"))
                )
        if benchmark:
            data = np.fromfile(directory / "sample.input.f32", dtype="<f4").reshape(
                SHAPE
            )
            for _ in range(10):
                interpreter.set_tensor(inp, data)
                interpreter.invoke()
                [interpreter.get_tensor(o) for o in outputs]
            times = []
            for _ in range(100):
                started = time.perf_counter()
                interpreter.set_tensor(inp, data)
                interpreter.invoke()
                [interpreter.get_tensor(o) for o in outputs]
                times.append((time.perf_counter() - started) * 1000)
            results.append(
                {
                    "threads": threads,
                    "loadMs": load_ms,
                    "medianMs": float(np.median(times)),
                    "p95Ms": float(np.percentile(times, 95)),
                }
            )
    report = {
        "litertVersion": importlib.metadata.version("ai-edge-litert"),
        "cases": len(list(directory.glob("*.expected.f32"))),
        "results": results,
    }
    (directory / ("xnnpack.json" if benchmark else "references.json")).write_text(
        json.dumps(report, indent=2) + "\n"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--benchmark", action="store_true")
    mode.add_argument("--model-goldens", action="store_true")
    args = parser.parse_args()
    if args.model_goldens:
        model_goldens(args.directory)
    else:
        references(args.directory, args.benchmark)
