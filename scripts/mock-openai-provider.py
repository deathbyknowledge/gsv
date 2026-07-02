#!/usr/bin/env python3
"""Small OpenAI-compatible mock provider for GSV custom-provider testing."""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


MODEL_ID = "gsv-mock"


def now() -> int:
    return int(time.time())


def compact_json(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def extract_prompt(payload: dict[str, Any]) -> str:
    messages = payload.get("messages")
    if isinstance(messages, list):
        for message in reversed(messages):
            if not isinstance(message, dict) or message.get("role") != "user":
                continue
            content = message.get("content")
            if isinstance(content, str):
                return content.strip()
            if isinstance(content, list):
                parts: list[str] = []
                for part in content:
                    if isinstance(part, dict):
                        text = part.get("text")
                        if isinstance(text, str):
                            parts.append(text)
                return " ".join(parts).strip()

    input_value = payload.get("input")
    if isinstance(input_value, str):
        return input_value.strip()
    if isinstance(input_value, list):
        parts = []
        for item in input_value:
            if isinstance(item, dict):
                content = item.get("content")
                if isinstance(content, str):
                    parts.append(content)
                elif isinstance(content, list):
                    for part in content:
                        if isinstance(part, dict) and isinstance(part.get("text"), str):
                            parts.append(part["text"])
        return " ".join(parts).strip()

    return ""


def reply_text(payload: dict[str, Any]) -> str:
    prompt = extract_prompt(payload)
    host = socket.gethostname()
    if "pong" in prompt.lower() or "ping" in prompt.lower():
        return f"pong from {host} via {MODEL_ID}"
    if prompt:
        return f"{MODEL_ID} on {host} received: {prompt}"
    return f"hello from {MODEL_ID} on {host}"


class MockProviderHandler(BaseHTTPRequestHandler):
    server_version = "gsv-mock-openai/1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {fmt % args}\n")
        sys.stderr.flush()

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/v1/models":
            self.write_json({
                "object": "list",
                "data": [{
                    "id": MODEL_ID,
                    "object": "model",
                    "created": now(),
                    "owned_by": "gsv-local",
                }],
            })
            return
        self.write_json({"error": {"message": "not found"}}, status=404)

    def do_POST(self) -> None:
        try:
            payload = self.read_json_body()
        except Exception as exc:
            self.write_json({"error": {"message": f"invalid json: {exc}"}}, status=400)
            return

        model = str(payload.get("model") or MODEL_ID)
        auth = self.headers.get("authorization", "")
        auth_label = "<none>" if not auth else f"{auth[:14]}..."
        self.log_message(
            "POST %s model=%s stream=%s auth=%s prompt=%r",
            self.path,
            model,
            payload.get("stream"),
            auth_label,
            extract_prompt(payload)[:160],
        )

        path = self.path.rstrip("/")
        if path == "/v1/chat/completions":
            self.handle_chat_completions(payload, model)
            return
        if path == "/v1/responses":
            self.handle_responses(payload, model)
            return
        self.write_json({"error": {"message": "not found"}}, status=404)

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("body must be an object")
        return value

    def write_json(self, value: Any, status: int = 200) -> None:
        body = compact_json(value)
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_sse(self, events: list[Any]) -> None:
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        for event in events:
            if isinstance(event, str):
                line = f"data: {event}\n\n".encode("utf-8")
            else:
                line = b"data: " + compact_json(event) + b"\n\n"
            self.wfile.write(line)
            self.wfile.flush()
            time.sleep(0.02)

    def handle_chat_completions(self, payload: dict[str, Any], model: str) -> None:
        text = reply_text(payload)
        response_id = f"chatcmpl-gsv-mock-{now()}"
        if payload.get("stream") is True:
            self.write_sse([
                {
                    "id": response_id,
                    "object": "chat.completion.chunk",
                    "created": now(),
                    "model": model,
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                },
                {
                    "id": response_id,
                    "object": "chat.completion.chunk",
                    "created": now(),
                    "model": model,
                    "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                },
                {
                    "id": response_id,
                    "object": "chat.completion.chunk",
                    "created": now(),
                    "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": {
                        "prompt_tokens": 8,
                        "completion_tokens": max(1, len(text.split())),
                        "total_tokens": 8 + max(1, len(text.split())),
                    },
                },
                "[DONE]",
            ])
            return

        self.write_json({
            "id": response_id,
            "object": "chat.completion",
            "created": now(),
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": 8,
                "completion_tokens": max(1, len(text.split())),
                "total_tokens": 8 + max(1, len(text.split())),
            },
        })

    def handle_responses(self, payload: dict[str, Any], model: str) -> None:
        text = reply_text(payload)
        response_id = f"resp-gsv-mock-{now()}"
        if payload.get("stream") is True:
            self.write_sse([
                {"type": "response.created", "response": {"id": response_id, "model": model}},
                {"type": "response.output_text.delta", "delta": text},
                {"type": "response.output_text.done", "text": text},
                {
                    "type": "response.completed",
                    "response": {
                        "id": response_id,
                        "model": model,
                        "status": "completed",
                        "output": [{
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": text}],
                        }],
                        "usage": {
                            "input_tokens": 8,
                            "output_tokens": max(1, len(text.split())),
                            "total_tokens": 8 + max(1, len(text.split())),
                        },
                    },
                },
                "[DONE]",
            ])
            return

        self.write_json({
            "id": response_id,
            "object": "response",
            "model": model,
            "status": "completed",
            "output_text": text,
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            }],
            "usage": {
                "input_tokens": 8,
                "output_tokens": max(1, len(text.split())),
                "total_tokens": 8 + max(1, len(text.split())),
            },
        })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18080)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), MockProviderHandler)
    print(f"mock OpenAI-compatible provider listening on http://{args.host}:{args.port}/v1", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down", flush=True)


if __name__ == "__main__":
    main()
