from __future__ import annotations

import argparse
import contextlib
import http.client
import importlib.util
import io
import json
import socket
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).with_name("mock-openai-provider.py")
SPEC = importlib.util.spec_from_file_location("gsv_mock_openai_provider", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"could not load {SCRIPT_PATH}")
provider = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = provider
SPEC.loader.exec_module(provider)


class MockOpenAIProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.request_logs = io.StringIO()
        self.log_capture = contextlib.redirect_stderr(self.request_logs)
        self.log_capture.__enter__()
        self.server = provider.MockProviderServer(
            ("127.0.0.1", 0),
            provider.MockProviderHandler,
        )
        self.server.delay_ms = 10
        self.server.shell_target = "e2e-device"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host, self.port = self.server.server_address

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)
        self.log_capture.__exit__(None, None, None)

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        body = None if payload is None else json.dumps(payload).encode()
        request_headers = dict(headers or {})
        if body is not None:
            request_headers.setdefault("content-type", "application/json")
        connection = http.client.HTTPConnection(self.host, self.port, timeout=2)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            return (
                response.status,
                {name.lower(): value for name, value in response.getheaders()},
                response.read(),
            )
        finally:
            connection.close()

    def post_json(
        self,
        path: str,
        payload: dict[str, Any],
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        status, _, body = self.request("POST", path, payload, headers)
        return status, json.loads(body)

    def post_sse(
        self,
        path: str,
        payload: dict[str, Any],
        headers: dict[str, str] | None = None,
    ) -> tuple[int, list[dict[str, Any]]]:
        status, response_headers, body = self.request("POST", path, payload, headers)
        self.assertEqual(response_headers.get("content-type"), "text/event-stream")
        events: list[dict[str, Any]] = []
        for block in body.decode().split("\n\n"):
            if not block.startswith("data: "):
                continue
            data = block.removeprefix("data: ")
            if data and data != "[DONE]":
                events.append(json.loads(data))
        return status, events

    def shell_tools(self, api: str) -> list[dict[str, Any]]:
        parameters = {
            "type": "object",
            "properties": {"input": {"type": "string"}, "target": {"type": "string"}},
            "required": ["input"],
        }
        if api == "chat":
            return [{
                "type": "function",
                "function": {
                    "name": "Shell",
                    "description": "execute a command",
                    "parameters": parameters,
                },
            }]
        return [{
            "type": "function",
            "name": "Shell",
            "description": "execute a command",
            "parameters": parameters,
            "strict": False,
        }]

    def test_health_and_models(self) -> None:
        status, _, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"status": "ok", "model": provider.MODEL_ID})

        status, _, body = self.request("GET", "/v1/models")
        self.assertEqual(status, 200)
        models = json.loads(body)
        self.assertEqual(models["data"][0]["id"], provider.MODEL_ID)

    def test_chat_exact_scenario_streaming_and_non_streaming(self) -> None:
        for stream in (False, True):
            with self.subTest(stream=stream):
                payload = {
                    "model": provider.MODEL_ID,
                    "messages": [{"role": "user", "content": provider.SCENARIO_MARKERS["exact"]}],
                    "stream": stream,
                }
                if stream:
                    status, events = self.post_sse("/v1/chat/completions", payload)
                    text = "".join(
                        event["choices"][0].get("delta", {}).get("content", "")
                        for event in events
                    )
                    self.assertEqual(events[-1]["choices"][0]["finish_reason"], "stop")
                else:
                    status, response = self.post_json("/v1/chat/completions", payload)
                    text = response["choices"][0]["message"]["content"]
                    self.assertEqual(response["choices"][0]["finish_reason"], "stop")
                self.assertEqual(status, 200)
                self.assertEqual(text, provider.EXACT_SENTINEL)

    def test_responses_exact_scenario_streaming_and_non_streaming(self) -> None:
        for stream in (False, True):
            with self.subTest(stream=stream):
                payload = {
                    "model": provider.MODEL_ID,
                    "input": [{
                        "role": "user",
                        "content": [{
                            "type": "input_text",
                            "text": provider.SCENARIO_MARKERS["exact"],
                        }],
                    }],
                    "stream": stream,
                }
                if stream:
                    status, events = self.post_sse("/v1/responses", payload)
                    types = [event["type"] for event in events]
                    self.assertIn("response.output_item.added", types)
                    self.assertIn("response.output_text.delta", types)
                    self.assertEqual(types[-1], "response.completed")
                    text = "".join(
                        event.get("delta", "")
                        for event in events
                        if event["type"] == "response.output_text.delta"
                    )
                else:
                    status, response = self.post_json("/v1/responses", payload)
                    text = response["output"][0]["content"][0]["text"]
                    self.assertEqual(response["status"], "completed")
                self.assertEqual(status, 200)
                self.assertEqual(text, provider.EXACT_SENTINEL)

    def test_default_text_behavior_is_preserved(self) -> None:
        prompt = "ping"
        status, response = self.post_json("/v1/chat/completions", {
            "model": provider.MODEL_ID,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
        })
        self.assertEqual(status, 200)
        self.assertIn("pong from", response["choices"][0]["message"]["content"])
        self.assertIn(provider.MODEL_ID, response["choices"][0]["message"]["content"])

    def test_chat_shell_scenario_calls_device_then_returns_final_sentinel(self) -> None:
        marker_message = {"role": "user", "content": provider.SCENARIO_MARKERS["shell"]}
        payload = {
            "model": provider.MODEL_ID,
            "messages": [marker_message],
            "tools": self.shell_tools("chat"),
            "stream": True,
        }
        status, events = self.post_sse("/v1/chat/completions", payload)
        self.assertEqual(status, 200)
        tool_delta = next(
            event["choices"][0]["delta"]["tool_calls"][0]
            for event in events
            if event["choices"][0].get("delta", {}).get("tool_calls")
        )
        self.assertEqual(tool_delta["id"], provider.SHELL_CALL_ID)
        self.assertEqual(tool_delta["function"]["name"], "Shell")
        arguments = json.loads(tool_delta["function"]["arguments"])
        self.assertEqual(arguments, {
            "input": f"printf {provider.SHELL_COMMAND_SENTINEL}",
            "target": "e2e-device",
        })
        self.assertEqual(events[-1]["choices"][0]["finish_reason"], "tool_calls")

        follow_up = {
            **payload,
            "messages": [
                marker_message,
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": provider.SHELL_CALL_ID,
                        "type": "function",
                        "function": tool_delta["function"],
                    }],
                },
                {
                    "role": "tool",
                    "tool_call_id": provider.SHELL_CALL_ID,
                    "content": json.dumps({
                        "status": "completed",
                        "output": provider.SHELL_COMMAND_SENTINEL,
                        "exitCode": 0,
                    }),
                },
            ],
        }
        status, events = self.post_sse("/v1/chat/completions", follow_up)
        text = "".join(
            event["choices"][0].get("delta", {}).get("content", "")
            for event in events
        )
        self.assertEqual(status, 200)
        self.assertEqual(text, provider.SHELL_SENTINEL)

    def test_responses_shell_scenario_emits_valid_function_call(self) -> None:
        user_item = {
            "role": "user",
            "content": [{"type": "input_text", "text": provider.SCENARIO_MARKERS["shell"]}],
        }
        payload = {
            "model": provider.MODEL_ID,
            "input": [user_item],
            "tools": self.shell_tools("responses"),
            "stream": True,
        }
        status, events = self.post_sse("/v1/responses", payload)
        self.assertEqual(status, 200)
        added = next(event for event in events if event["type"] == "response.output_item.added")
        self.assertEqual(added["item"]["type"], "function_call")
        self.assertEqual(added["item"]["name"], "Shell")
        done = next(event for event in events if event["type"] == "response.output_item.done")
        self.assertEqual(done["item"]["call_id"], provider.SHELL_CALL_ID)
        self.assertEqual(json.loads(done["item"]["arguments"])["target"], "e2e-device")

        follow_up = {
            **payload,
            "input": [
                user_item,
                done["item"],
                {
                    "type": "function_call_output",
                    "call_id": provider.SHELL_CALL_ID,
                    "output": json.dumps({"output": provider.SHELL_COMMAND_SENTINEL}),
                },
            ],
        }
        status, events = self.post_sse("/v1/responses", follow_up)
        text = "".join(
            event.get("delta", "")
            for event in events
            if event["type"] == "response.output_text.delta"
        )
        self.assertEqual(status, 200)
        self.assertEqual(text, provider.SHELL_SENTINEL)

    def test_delegate_scenario_covers_parent_child_and_result_event(self) -> None:
        marker_message = {"role": "user", "content": provider.SCENARIO_MARKERS["delegate"]}
        base = {
            "model": provider.MODEL_ID,
            "messages": [marker_message],
            "tools": self.shell_tools("chat"),
            "stream": False,
        }
        status, response = self.post_json("/v1/chat/completions", base)
        self.assertEqual(status, 200)
        tool_call = response["choices"][0]["message"]["tool_calls"][0]
        self.assertEqual(tool_call["id"], provider.DELEGATE_CALL_ID)
        self.assertEqual(json.loads(tool_call["function"]["arguments"]), {
            "input": provider.DELEGATE_COMMAND,
            "target": "gsv",
        })

        status, response = self.post_json("/v1/chat/completions", {
            **base,
            "messages": [
                marker_message,
                response["choices"][0]["message"],
                {
                    "role": "tool",
                    "tool_call_id": provider.DELEGATE_CALL_ID,
                    "content": "status=in_progress task=ipc-1 pid=child-1",
                },
            ],
        })
        self.assertEqual(status, 200)
        self.assertEqual(
            response["choices"][0]["message"]["content"],
            provider.DELEGATE_WAITING_SENTINEL,
        )

        status, response = self.post_json("/v1/chat/completions", {
            "model": provider.MODEL_ID,
            "messages": [{
                "role": "user",
                "content": (
                    "Delegated task from parent (parent-1).\n\n"
                    f"{provider.DELEGATE_CHILD_TASK}\n\n"
                    "Your final answer will be returned to the caller automatically."
                ),
            }],
            "stream": False,
        })
        self.assertEqual(status, 200)
        self.assertEqual(
            response["choices"][0]["message"]["content"],
            provider.DELEGATE_CHILD_SENTINEL,
        )

        status, response = self.post_json("/v1/chat/completions", {
            **base,
            "messages": [
                marker_message,
                {
                    "role": "user",
                    "content": (
                        "[Process Event]:\n"
                        "Delegated task from process `child-1` finished.\n\n"
                        f"Result: {provider.DELEGATE_CHILD_SENTINEL}"
                    ),
                },
            ],
        })
        self.assertEqual(status, 200)
        self.assertEqual(
            response["choices"][0]["message"]["content"],
            provider.DELEGATE_SENTINEL,
        )

        responses_user = {
            "role": "user",
            "content": [{
                "type": "input_text",
                "text": provider.SCENARIO_MARKERS["delegate"],
            }],
        }
        responses_payload = {
            "model": provider.MODEL_ID,
            "input": [responses_user],
            "tools": self.shell_tools("responses"),
            "stream": False,
        }
        status, response = self.post_json("/v1/responses", responses_payload)
        self.assertEqual(status, 200)
        function_call = response["output"][0]
        self.assertEqual(function_call["type"], "function_call")
        self.assertEqual(function_call["call_id"], provider.DELEGATE_CALL_ID)
        self.assertEqual(json.loads(function_call["arguments"]), {
            "input": provider.DELEGATE_COMMAND,
            "target": "gsv",
        })

        status, response = self.post_json("/v1/responses", {
            **responses_payload,
            "input": [
                responses_user,
                function_call,
                {
                    "type": "function_call_output",
                    "call_id": provider.DELEGATE_CALL_ID,
                    "output": "status=in_progress task=ipc-2 pid=child-2",
                },
            ],
        })
        self.assertEqual(status, 200)
        self.assertEqual(response["output_text"], provider.DELEGATE_WAITING_SENTINEL)

    def test_delay_is_bounded_and_configurable(self) -> None:
        self.server.delay_ms = 35
        started_at = time.monotonic()
        status, response = self.post_json("/v1/chat/completions", {
            "model": provider.MODEL_ID,
            "messages": [{"role": "user", "content": provider.SCENARIO_MARKERS["delay"]}],
            "stream": False,
        })
        elapsed = time.monotonic() - started_at
        self.assertEqual(status, 200)
        self.assertGreaterEqual(elapsed, 0.025)
        self.assertEqual(response["choices"][0]["message"]["content"], provider.DELAY_SENTINEL)
        self.assertEqual(provider.bounded_delay_ms("0"), 0)
        self.assertEqual(provider.bounded_delay_ms(str(provider.MAX_DELAY_MS)), provider.MAX_DELAY_MS)
        with self.assertRaises(argparse.ArgumentTypeError):
            provider.bounded_delay_ms(str(provider.MAX_DELAY_MS + 1))

    def test_request_logs_use_an_allowlist_and_redact_private_values(self) -> None:
        private_prompt = "PRIVATE-PROMPT-739"
        private_token = "PRIVATE-TOKEN-241"
        private_tool_argument = "PRIVATE-TOOL-ARGUMENT-985"
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            status, response = self.post_json(
                "/v1/chat/completions?private-query=PRIVATE-QUERY-631",
                {
                    "model": {"private": "PRIVATE-MODEL-PAYLOAD-417"},
                    "messages": [{"role": "user", "content": private_prompt}],
                    "tools": [{
                        "type": "function",
                        "function": {
                            "name": "SecretTool",
                            "description": private_tool_argument,
                            "parameters": {"type": "object"},
                        },
                    }],
                    "stream": False,
                },
                {
                    "authorization": f"Bearer {private_token}",
                    provider.SCENARIO_HEADER: "exact",
                },
            )
        self.assertEqual(status, 200)
        self.assertEqual(response["choices"][0]["message"]["content"], provider.EXACT_SENTINEL)
        logs = captured.getvalue()
        for private_value in (
            private_prompt,
            private_token,
            private_tool_argument,
            "PRIVATE-MODEL-PAYLOAD-417",
            "PRIVATE-QUERY-631",
            "authorization",
        ):
            self.assertNotIn(private_value, logs)
        event = json.loads(logs.strip())
        self.assertEqual(event["path"], "/v1/chat/completions")
        self.assertEqual(event["scenario"], "exact")
        self.assertEqual(event["outcome"], "ok")
        self.assertLessEqual(
            set(event),
            {
                "event",
                "method",
                "path",
                "request_id",
                "status",
                "outcome",
                "duration_ms",
                "model",
                "stream",
                "scenario",
            },
        )

    def test_delay_disconnect_is_clean(self) -> None:
        self.server.delay_ms = 1_000
        payload = json.dumps({
            "model": provider.MODEL_ID,
            "messages": [{"role": "user", "content": provider.SCENARIO_MARKERS["delay"]}],
            "stream": False,
        }).encode()
        request = (
            b"POST /v1/chat/completions HTTP/1.0\r\n"
            b"Host: localhost\r\n"
            b"Content-Type: application/json\r\n"
            + f"Content-Length: {len(payload)}\r\n\r\n".encode()
            + payload
        )
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            client = socket.create_connection((self.host, self.port), timeout=1)
            client.sendall(request)
            client.close()
            deadline = time.monotonic() + 1
            while '"outcome":"disconnected"' not in captured.getvalue():
                if time.monotonic() >= deadline:
                    self.fail(f"server did not detect disconnect; logs: {captured.getvalue()!r}")
                time.sleep(0.01)
        self.assertNotIn("Traceback", captured.getvalue())


if __name__ == "__main__":
    unittest.main()
