#!/usr/bin/env python3
"""Deterministic, OpenAI-compatible provider fixture for GSV end-to-end tests.

The fixture intentionally logs request metadata only. It never logs headers,
prompts, message content, tool arguments, or response payloads.
"""

from __future__ import annotations

import argparse
import json
import select
import socket
import sys
import time
import uuid
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit


MODEL_ID = "gsv-mock"
SCENARIO_HEADER = "X-GSV-E2E-Scenario"
SCENARIO_MARKERS = {
    "exact": "[[gsv-e2e:exact]]",
    "shell": "[[gsv-e2e:shell]]",
    "delay": "[[gsv-e2e:delay]]",
    "delegate": "[[gsv-e2e:delegate]]",
}

EXACT_SENTINEL = "GSV_E2E_TEXT_OK"
SHELL_COMMAND_SENTINEL = "GSV_E2E_SHELL_COMMAND_OK"
SHELL_SENTINEL = "GSV_E2E_SHELL_OK"
SHELL_RESULT_MISMATCH_SENTINEL = "GSV_E2E_SHELL_RESULT_MISMATCH"
DELAY_SENTINEL = "GSV_E2E_DELAY_OK"
DELEGATE_CHILD_SENTINEL = "GSV_E2E_DELEGATE_CHILD_OK"
DELEGATE_SENTINEL = "GSV_E2E_DELEGATE_OK"
DELEGATE_WAITING_SENTINEL = "GSV_E2E_DELEGATE_WAITING"
DELEGATE_START_MISMATCH_SENTINEL = "GSV_E2E_DELEGATE_START_MISMATCH"

SHELL_CALL_ID = "call_gsv_e2e_shell"
SHELL_ITEM_ID = "fc_gsv_e2e_shell"
DELEGATE_CALL_ID = "call_gsv_e2e_delegate"
DELEGATE_ITEM_ID = "fc_gsv_e2e_delegate"
DELEGATE_CHILD_TASK = f"Reply exactly {DELEGATE_CHILD_SENTINEL}"
DELEGATE_COMMAND = f'proc delegate --timeout 2m "{DELEGATE_CHILD_TASK}"'
DEFAULT_DELAY_MS = 5_000
MAX_DELAY_MS = 30_000
MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024
DISCONNECT_POLL_SECONDS = 0.05
SSE_EVENT_INTERVAL_SECONDS = 0.005


class ClientDisconnected(Exception):
    """Raised when a response can no longer be delivered to the caller."""


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class MockProviderServer(ThreadingHTTPServer):
    daemon_threads = True

    delay_ms: int = DEFAULT_DELAY_MS
    shell_target: str | None = None


def now() -> int:
    return int(time.time())


def compact_json(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def content_text(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
        return
    if not isinstance(value, list):
        return
    for part in value:
        if isinstance(part, str):
            yield part
        elif isinstance(part, dict):
            text = part.get("text")
            if isinstance(text, str):
                yield text


def model_input_text(payload: dict[str, Any]) -> Iterator[str]:
    """Yield model-visible text in provider order without retaining or logging it."""
    messages = payload.get("messages")
    if isinstance(messages, list):
        for message in messages:
            if (
                isinstance(message, dict)
                and message.get("role") in {"system", "developer", "user", "assistant"}
            ):
                yield from content_text(message.get("content"))

    input_value = payload.get("input")
    if isinstance(input_value, str):
        yield input_value
    elif isinstance(input_value, list):
        for item in input_value:
            if not isinstance(item, dict):
                continue
            # Function-call arguments and outputs are deliberately excluded.
            # The original user marker remains in the input on the follow-up.
            if item.get("role") in {"system", "developer", "user", "assistant"}:
                yield from content_text(item.get("content"))


def extract_prompt(payload: dict[str, Any]) -> str:
    """Preserve the fixture's legacy default reply behavior."""
    messages = payload.get("messages")
    if isinstance(messages, list):
        for message in reversed(messages):
            if not isinstance(message, dict) or message.get("role") != "user":
                continue
            return " ".join(content_text(message.get("content"))).strip()

    input_value = payload.get("input")
    if isinstance(input_value, str):
        return input_value.strip()
    if isinstance(input_value, list):
        parts: list[str] = []
        for item in input_value:
            if not isinstance(item, dict):
                continue
            if item.get("role") == "user":
                parts.extend(content_text(item.get("content")))
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


def marker_scenario(payload: dict[str, Any]) -> str | None:
    """Return the last scenario marker so a newer user turn can supersede one."""
    selected: str | None = None
    for text in model_input_text(payload):
        last_match: tuple[int, str] | None = None
        for scenario, marker in SCENARIO_MARKERS.items():
            position = text.rfind(marker)
            if position >= 0 and (last_match is None or position > last_match[0]):
                last_match = (position, scenario)
        if last_match is not None:
            selected = last_match[1]
    return selected


def has_shell_tool(payload: dict[str, Any], api: str) -> bool:
    tools = payload.get("tools")
    if not isinstance(tools, list):
        return False
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        if api == "chat":
            function = tool.get("function")
            if isinstance(function, dict) and function.get("name") == "Shell":
                return True
        elif tool.get("name") == "Shell":
            return True
    return False


def contains_text(value: Any, expected: str) -> bool:
    if isinstance(value, str):
        return expected in value
    if isinstance(value, list):
        return any(contains_text(item, expected) for item in value)
    if isinstance(value, dict):
        return any(contains_text(item, expected) for item in value.values())
    return False


def tool_result_value(payload: dict[str, Any], api: str, call_id: str) -> tuple[bool, Any]:
    if api == "chat":
        values = payload.get("messages")
        if not isinstance(values, list):
            return False, None
        for item in reversed(values):
            if (
                isinstance(item, dict)
                and item.get("role") == "tool"
                and item.get("tool_call_id") == call_id
            ):
                return True, item.get("content")
        return False, None

    values = payload.get("input")
    if not isinstance(values, list):
        return False, None
    for item in reversed(values):
        if (
            isinstance(item, dict)
            and item.get("type") == "function_call_output"
            and item.get("call_id") == call_id
        ):
            return True, item.get("output")
    return False, None


def shell_result_state(payload: dict[str, Any], api: str) -> str:
    """Return missing, success, or mismatch for this fixture's tool call."""
    found, value = tool_result_value(payload, api, SHELL_CALL_ID)
    if not found:
        return "missing"
    return "success" if contains_text(value, SHELL_COMMAND_SENTINEL) else "mismatch"


def delegate_model_phase(payload: dict[str, Any]) -> str | None:
    """Recognize the child task or the parent's eventual delegated-result event."""
    texts = list(model_input_text(payload))
    if any(
        DELEGATE_CHILD_SENTINEL in text
        and "Delegated task from process" in text
        and "finished" in text
        for text in texts
    ):
        return "parent_complete"
    if any(DELEGATE_CHILD_TASK in text for text in texts):
        return "child"
    return None


def usage(text: str, api: str) -> dict[str, int]:
    output_tokens = max(1, len(text.split()))
    if api == "chat":
        return {
            "prompt_tokens": 8,
            "completion_tokens": output_tokens,
            "total_tokens": 8 + output_tokens,
        }
    return {
        "input_tokens": 8,
        "output_tokens": output_tokens,
        "total_tokens": 8 + output_tokens,
    }


def bounded_delay_ms(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("delay must be an integer number of milliseconds") from exc
    if parsed < 0 or parsed > MAX_DELAY_MS:
        raise argparse.ArgumentTypeError(f"delay must be between 0 and {MAX_DELAY_MS} milliseconds")
    return parsed


class MockProviderHandler(BaseHTTPRequestHandler):
    server_version = "gsv-mock-openai/2"

    @property
    def fixture_server(self) -> MockProviderServer:
        return self.server  # type: ignore[return-value]

    def log_message(self, _fmt: str, *_args: Any) -> None:
        # BaseHTTPRequestHandler logs the raw request line. All logging instead
        # goes through log_request_metadata with an explicit allowlist.
        return

    def log_request_metadata(
        self,
        *,
        method: str,
        path: str,
        request_id: str,
        status: int,
        outcome: str,
        started_at: float,
        model: str | None = None,
        stream: bool | None = None,
        scenario: str | None = None,
    ) -> None:
        event: dict[str, Any] = {
            "event": "request",
            "method": method,
            "path": path,
            "request_id": request_id,
            "status": status,
            "outcome": outcome,
            "duration_ms": round((time.monotonic() - started_at) * 1000, 1),
        }
        if model is not None:
            event["model"] = model[:128]
        if stream is not None:
            event["stream"] = stream
        if scenario is not None:
            event["scenario"] = scenario
        sys.stderr.write(json.dumps(event, separators=(",", ":")) + "\n")
        sys.stderr.flush()

    def do_GET(self) -> None:
        request_id = uuid.uuid4().hex
        started_at = time.monotonic()
        path = urlsplit(self.path).path.rstrip("/") or "/"
        status = 500
        outcome = "error"
        try:
            if path == "/health":
                status = 200
                self.write_json({"status": "ok", "model": MODEL_ID})
                outcome = "ok"
                return
            if path == "/v1/models":
                status = 200
                self.write_json({
                    "object": "list",
                    "data": [{
                        "id": MODEL_ID,
                        "object": "model",
                        "created": now(),
                        "owned_by": "gsv-local",
                    }],
                })
                outcome = "ok"
                return
            status = 404
            self.write_json({"error": {"message": "not found"}}, status=status)
            outcome = "not_found"
        except ClientDisconnected:
            status = 499
            outcome = "disconnected"
        finally:
            self.log_request_metadata(
                method="GET",
                path=path,
                request_id=request_id,
                status=status,
                outcome=outcome,
                started_at=started_at,
            )

    def do_POST(self) -> None:
        request_id = uuid.uuid4().hex
        started_at = time.monotonic()
        path = urlsplit(self.path).path.rstrip("/") or "/"
        status = 500
        outcome = "error"
        model: str | None = None
        stream: bool | None = None
        scenario: str | None = None
        try:
            try:
                payload = self.read_json_body()
            except RequestError as exc:
                status = exc.status
                self.write_json({"error": {"message": exc.message}}, status=status)
                outcome = "invalid_request"
                return

            raw_model = payload.get("model")
            model = raw_model if isinstance(raw_model, str) and raw_model else MODEL_ID
            stream = payload.get("stream") is True
            header_scenario = self.headers.get(SCENARIO_HEADER)
            if header_scenario is not None:
                normalized = header_scenario.strip().lower()
                if normalized not in SCENARIO_MARKERS:
                    status = 400
                    self.write_json({"error": {"message": "unknown e2e scenario"}}, status=status)
                    outcome = "invalid_scenario"
                    return
                scenario = normalized
            else:
                scenario = marker_scenario(payload)

            if path == "/v1/chat/completions":
                status = self.handle_chat_completions(payload, model, request_id, scenario)
                outcome = "ok" if status == 200 else "scenario_error"
                return
            if path == "/v1/responses":
                status = self.handle_responses(payload, model, request_id, scenario)
                outcome = "ok" if status == 200 else "scenario_error"
                return
            status = 404
            self.write_json({"error": {"message": "not found"}}, status=status)
            outcome = "not_found"
        except ClientDisconnected:
            status = 499
            outcome = "disconnected"
        finally:
            self.log_request_metadata(
                method="POST",
                path=path,
                request_id=request_id,
                status=status,
                outcome=outcome,
                started_at=started_at,
                model=model,
                stream=stream,
                scenario=scenario,
            )

    def read_json_body(self) -> dict[str, Any]:
        raw_length = self.headers.get("content-length", "0")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise RequestError(400, "invalid content length") from exc
        if length < 0:
            raise RequestError(400, "invalid content length")
        if length > MAX_REQUEST_BODY_BYTES:
            self.close_connection = True
            raise RequestError(413, "request body too large")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        if len(raw) != length:
            raise ClientDisconnected()
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RequestError(400, "invalid JSON body") from exc
        if not isinstance(value, dict):
            raise RequestError(400, "body must be an object")
        return value

    def write_json(self, value: Any, status: int = 200) -> None:
        body = compact_json(value)
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError) as exc:
            raise ClientDisconnected() from exc

    def write_sse(self, events: list[Any]) -> None:
        try:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.send_header("x-accel-buffering", "no")
            self.end_headers()
            for event in events:
                if isinstance(event, str):
                    line = f"data: {event}\n\n".encode("utf-8")
                else:
                    line = b"data: " + compact_json(event) + b"\n\n"
                self.wfile.write(line)
                self.wfile.flush()
                time.sleep(SSE_EVENT_INTERVAL_SECONDS)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError) as exc:
            raise ClientDisconnected() from exc

    def wait_for_delay(self) -> None:
        deadline = time.monotonic() + self.fixture_server.delay_ms / 1000
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            timeout = min(DISCONNECT_POLL_SECONDS, remaining)
            try:
                readable, _, _ = select.select([self.connection], [], [], timeout)
            except (OSError, ValueError) as exc:
                raise ClientDisconnected() from exc
            if not readable:
                continue
            try:
                pending = self.connection.recv(1, socket.MSG_PEEK)
            except BlockingIOError:
                continue
            except (ConnectionAbortedError, ConnectionResetError, OSError) as exc:
                raise ClientDisconnected() from exc
            if not pending:
                raise ClientDisconnected()
            # Extra pipelined bytes are not expected, but do not spin if present.
            time.sleep(timeout)

    def scenario_text(self, payload: dict[str, Any], scenario: str | None) -> str:
        if scenario == "exact":
            return EXACT_SENTINEL
        if scenario == "delay":
            self.wait_for_delay()
            return DELAY_SENTINEL
        return reply_text(payload)

    def validate_shell_scenario(
        self,
        payload: dict[str, Any],
        api: str,
    ) -> tuple[int, str | None]:
        result_state = shell_result_state(payload, api)
        if result_state == "success":
            return 200, SHELL_SENTINEL
        if result_state == "mismatch":
            return 200, SHELL_RESULT_MISMATCH_SENTINEL
        if not self.fixture_server.shell_target:
            self.write_json(
                {"error": {"message": "shell scenario requires --shell-target"}},
                status=400,
            )
            return 400, None
        if not has_shell_tool(payload, api):
            self.write_json(
                {"error": {"message": "shell scenario requires the Shell tool"}},
                status=400,
            )
            return 400, None
        return 200, None

    def validate_delegate_scenario(
        self,
        payload: dict[str, Any],
        api: str,
    ) -> tuple[int, str | None]:
        found, result = tool_result_value(payload, api, DELEGATE_CALL_ID)
        if found:
            if contains_text(result, "status=in_progress"):
                return 200, DELEGATE_WAITING_SENTINEL
            return 200, DELEGATE_START_MISMATCH_SENTINEL
        if not has_shell_tool(payload, api):
            self.write_json(
                {"error": {"message": "delegate scenario requires the Shell tool"}},
                status=400,
            )
            return 400, None
        return 200, None

    def handle_chat_completions(
        self,
        payload: dict[str, Any],
        model: str,
        request_id: str,
        scenario: str | None,
    ) -> int:
        response_id = f"chatcmpl-gsv-mock-{request_id}"
        delegate_phase = delegate_model_phase(payload)
        if delegate_phase == "parent_complete":
            self.write_chat_text(payload, model, response_id, DELEGATE_SENTINEL)
            return 200
        if delegate_phase == "child":
            self.write_chat_text(payload, model, response_id, DELEGATE_CHILD_SENTINEL)
            return 200
        if scenario == "delegate":
            status, waiting_text = self.validate_delegate_scenario(payload, "chat")
            if status != 200:
                return status
            if waiting_text is None:
                self.write_chat_tool_call(
                    payload,
                    model,
                    response_id,
                    call_id=DELEGATE_CALL_ID,
                    target="gsv",
                    command=DELEGATE_COMMAND,
                )
            else:
                self.write_chat_text(payload, model, response_id, waiting_text)
            return 200
        if scenario == "shell":
            status, final_text = self.validate_shell_scenario(payload, "chat")
            if status != 200:
                return status
            if final_text is None:
                target = self.fixture_server.shell_target
                if target is None:
                    raise RuntimeError("shell target disappeared after validation")
                self.write_chat_tool_call(
                    payload,
                    model,
                    response_id,
                    call_id=SHELL_CALL_ID,
                    target=target,
                    command=f"printf {SHELL_COMMAND_SENTINEL}",
                )
            else:
                self.write_chat_text(payload, model, response_id, final_text)
            return 200

        self.write_chat_text(
            payload,
            model,
            response_id,
            self.scenario_text(payload, scenario),
        )
        return 200

    def write_chat_text(
        self,
        payload: dict[str, Any],
        model: str,
        response_id: str,
        text: str,
    ) -> None:
        created = now()
        response_usage = usage(text, "chat")
        if payload.get("stream") is True:
            self.write_sse([
                {
                    "id": response_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                },
                {
                    "id": response_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                },
                {
                    "id": response_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": response_usage,
                },
                "[DONE]",
            ])
            return

        self.write_json({
            "id": response_id,
            "object": "chat.completion",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }],
            "usage": response_usage,
        })

    def write_chat_tool_call(
        self,
        payload: dict[str, Any],
        model: str,
        response_id: str,
        *,
        call_id: str,
        target: str,
        command: str,
    ) -> None:
        created = now()
        arguments = json.dumps(
            {"input": command, "target": target},
            separators=(",", ":"),
        )
        tool_call = {
            "id": call_id,
            "type": "function",
            "function": {"name": "Shell", "arguments": arguments},
        }
        if payload.get("stream") is True:
            self.write_sse([
                {
                    "id": response_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                },
                {
                    "id": response_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {"tool_calls": [{"index": 0, **tool_call}]},
                        "finish_reason": None,
                    }],
                },
                {
                    "id": response_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                    "usage": usage("Shell", "chat"),
                },
                "[DONE]",
            ])
            return

        self.write_json({
            "id": response_id,
            "object": "chat.completion",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": None, "tool_calls": [tool_call]},
                "finish_reason": "tool_calls",
            }],
            "usage": usage("Shell", "chat"),
        })

    def handle_responses(
        self,
        payload: dict[str, Any],
        model: str,
        request_id: str,
        scenario: str | None,
    ) -> int:
        response_id = f"resp-gsv-mock-{request_id}"
        delegate_phase = delegate_model_phase(payload)
        if delegate_phase == "parent_complete":
            self.write_responses_text(payload, model, response_id, DELEGATE_SENTINEL)
            return 200
        if delegate_phase == "child":
            self.write_responses_text(payload, model, response_id, DELEGATE_CHILD_SENTINEL)
            return 200
        if scenario == "delegate":
            status, waiting_text = self.validate_delegate_scenario(payload, "responses")
            if status != 200:
                return status
            if waiting_text is None:
                self.write_responses_tool_call(
                    payload,
                    model,
                    response_id,
                    call_id=DELEGATE_CALL_ID,
                    item_id=DELEGATE_ITEM_ID,
                    target="gsv",
                    command=DELEGATE_COMMAND,
                )
            else:
                self.write_responses_text(payload, model, response_id, waiting_text)
            return 200
        if scenario == "shell":
            status, final_text = self.validate_shell_scenario(payload, "responses")
            if status != 200:
                return status
            if final_text is None:
                target = self.fixture_server.shell_target
                if target is None:
                    raise RuntimeError("shell target disappeared after validation")
                self.write_responses_tool_call(
                    payload,
                    model,
                    response_id,
                    call_id=SHELL_CALL_ID,
                    item_id=SHELL_ITEM_ID,
                    target=target,
                    command=f"printf {SHELL_COMMAND_SENTINEL}",
                )
            else:
                self.write_responses_text(payload, model, response_id, final_text)
            return 200

        self.write_responses_text(
            payload,
            model,
            response_id,
            self.scenario_text(payload, scenario),
        )
        return 200

    def response_object(
        self,
        response_id: str,
        model: str,
        output: list[dict[str, Any]],
        response_usage: dict[str, int],
    ) -> dict[str, Any]:
        return {
            "id": response_id,
            "object": "response",
            "created_at": now(),
            "model": model,
            "status": "completed",
            "output": output,
            "usage": response_usage,
        }

    def write_responses_text(
        self,
        payload: dict[str, Any],
        model: str,
        response_id: str,
        text: str,
    ) -> None:
        message_id = f"msg_{response_id[-24:]}"
        content = [{"type": "output_text", "text": text, "annotations": []}]
        item = {
            "id": message_id,
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": content,
        }
        response = self.response_object(response_id, model, [item], usage(text, "responses"))
        response["output_text"] = text
        if payload.get("stream") is True:
            in_progress_item = {**item, "status": "in_progress", "content": []}
            self.write_sse([
                {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                {"type": "response.output_item.added", "output_index": 0, "item": in_progress_item},
                {
                    "type": "response.content_part.added",
                    "item_id": message_id,
                    "output_index": 0,
                    "content_index": 0,
                    "part": {"type": "output_text", "text": "", "annotations": []},
                },
                {
                    "type": "response.output_text.delta",
                    "item_id": message_id,
                    "output_index": 0,
                    "content_index": 0,
                    "delta": text,
                },
                {
                    "type": "response.output_text.done",
                    "item_id": message_id,
                    "output_index": 0,
                    "content_index": 0,
                    "text": text,
                },
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": response},
                "[DONE]",
            ])
            return
        self.write_json(response)

    def write_responses_tool_call(
        self,
        payload: dict[str, Any],
        model: str,
        response_id: str,
        *,
        call_id: str,
        item_id: str,
        target: str,
        command: str,
    ) -> None:
        arguments = json.dumps(
            {"input": command, "target": target},
            separators=(",", ":"),
        )
        item = {
            "id": item_id,
            "type": "function_call",
            "status": "completed",
            "call_id": call_id,
            "name": "Shell",
            "arguments": arguments,
        }
        response = self.response_object(response_id, model, [item], usage("Shell", "responses"))
        if payload.get("stream") is True:
            self.write_sse([
                {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                {
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": {**item, "status": "in_progress", "arguments": ""},
                },
                {
                    "type": "response.function_call_arguments.delta",
                    "item_id": item_id,
                    "output_index": 0,
                    "delta": arguments,
                },
                {
                    "type": "response.function_call_arguments.done",
                    "item_id": item_id,
                    "output_index": 0,
                    "arguments": arguments,
                },
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": response},
                "[DONE]",
            ])
            return
        self.write_json(response)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument(
        "--delay-ms",
        type=bounded_delay_ms,
        default=DEFAULT_DELAY_MS,
        help=f"delay scenario duration (0-{MAX_DELAY_MS} ms; default: {DEFAULT_DELAY_MS})",
    )
    parser.add_argument(
        "--shell-target",
        help="connected GSV device id used by the shell scenario",
    )
    args = parser.parse_args()

    shell_target = args.shell_target.strip() if args.shell_target else None
    if args.shell_target and not shell_target:
        parser.error("--shell-target must not be empty")

    server = MockProviderServer((args.host, args.port), MockProviderHandler)
    server.delay_ms = args.delay_ms
    server.shell_target = shell_target
    print(f"mock OpenAI-compatible provider listening on http://{args.host}:{args.port}/v1", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
