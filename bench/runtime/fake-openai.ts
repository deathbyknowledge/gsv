import { createServer, type ServerResponse } from "node:http";
import type {
  JsonObject,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";

type FakeToolCall = {
  id: string;
  name: string;
  arguments: Record<string, JsonValue>;
};

type FakeResponse = FakeToolCall | { text: string };

const fakeMessageSchema = z.object({
  role: z.string(),
}).passthrough();
const fakeRequestSchema = z.object({
  model: z.string(),
  messages: z.array(fakeMessageSchema),
}).passthrough();
type FakeMessage = z.infer<typeof fakeMessageSchema>;

const port = parsePort(process.argv.slice(2));

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}\n');
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not found"}\n');
    return;
  }

  try {
    const payload = fakeRequestSchema.parse(JSON.parse(await readBody(request)));
    writeResponse(
      response,
      payload.model,
      selectResponse(payload.messages),
    );
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end('{"error":"invalid request"}\n');
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write("fake OpenAI server listening on 127.0.0.1:" + port + "\n");
});

function selectResponse(messages: FakeMessage[]): FakeResponse {
  const transcript = JSON.stringify(messages);
  const resultCount = toolResultCount(messages);
  if (transcript.includes("read-only incident research Process")) {
    const researchCalls: FakeToolCall[] = [
      {
        id: "discover-research-targets",
        name: "Shell",
        arguments: { input: "targets list --json", target: "gsv" },
      },
      {
        id: "read-release-runbook",
        name: "Read",
        arguments: {
          path: "/ops/runbooks/checkout.md",
          target: "incident-laptop",
        },
      },
      {
        id: "inspect-diagnostic-summary",
        name: "Shell",
        arguments: {
          input: "incidentctl summary",
          target: "checkout-diagnostics",
        },
      },
      {
        id: "inspect-incident-thread",
        name: "Shell",
        arguments: {
          input: "slack thread show INC-4821",
          target: "checkout-slack",
        },
      },
      {
        id: "read-vendor-advisory",
        name: "Read",
        arguments: {
          path: "/pages/advisory.txt",
          target: "checkout-vendor-browser",
        },
      },
    ];
    return researchCalls[resultCount] ?? {
      text: "Correlated the runbook, diagnostic snapshot, Slack chronology, and vendor advisory. The schema-checksum-mismatch-93bf began with checkout-2026.09.01; roll back to checkout-2026.08.31 and do not restart the bad build. checkout-2026.09.02-rc2 still requires approval and independent canary evidence.",
    };
  }
  if (transcript.includes("least-privilege rollback operator")) {
    const rollbackCalls: FakeToolCall[] = [
      {
        id: "discover-rollback-targets",
        name: "Shell",
        arguments: { input: "targets list --json", target: "gsv" },
      },
      {
        id: "inspect-production-status",
        name: "Shell",
        arguments: {
          input: "releasectl status",
          target: "checkout-production",
        },
      },
      {
        id: "inspect-production-history",
        name: "Shell",
        arguments: {
          input: "releasectl history",
          target: "checkout-production",
        },
      },
      {
        id: "rollback-production",
        name: "Shell",
        arguments: {
          input: "releasectl rollback checkout-2026.08.31",
          target: "checkout-production",
        },
      },
    ];
    return rollbackCalls[resultCount] ?? {
      text: "Rolled checkout back from checkout-2026.09.01 to checkout-2026.08.31. The rollback was accepted; independent monitoring must establish stability before canary work.",
    };
  }
  if (transcript.includes("You are a canary operator")) {
    const canaryCalls: FakeToolCall[] = [
      {
        id: "discover-canary-targets",
        name: "Shell",
        arguments: { input: "targets list --json", target: "gsv" },
      },
      {
        id: "read-canary-approval",
        name: "Read",
        arguments: {
          path: "/approvals/checkout.json",
          target: "checkout-approval",
        },
      },
      {
        id: "deploy-canary",
        name: "Shell",
        arguments: {
          input: "releasectl canary checkout-2026.09.02-rc2",
          target: "checkout-canary",
        },
      },
    ];
    return canaryCalls[resultCount] ?? {
      text: "Read approval APR-9921 and deployed checkout-2026.09.02-rc2 to canary. Independent canary health verification remains pending.",
    };
  }
  if (transcript.includes("You are a promotion operator")) {
    const promotionCalls: FakeToolCall[] = [
      {
        id: "discover-promotion-targets",
        name: "Shell",
        arguments: { input: "targets list --json", target: "gsv" },
      },
      {
        id: "promote-candidate",
        name: "Shell",
        arguments: {
          input: "releasectl promote checkout-2026.09.02-rc2",
          target: "checkout-promotion",
        },
      },
    ];
    return promotionCalls[resultCount] ?? {
      text: "Promoted checkout-2026.09.02-rc2 after Ship supplied the healthy canary evidence. Independent production stability verification remains pending.",
    };
  }
  if (transcript.includes("Incident INC-4821")) {
    const shipCalls: FakeToolCall[] = [
      {
        id: "ack-release-incident",
        name: "Shell",
        arguments: {
          input: "message send --message 'Acknowledged INC-4821; I am coordinating bounded recovery and will update after verified stability.'",
        },
      },
      {
        id: "retain-release-incident",
        name: "Shell",
        arguments: {
          input: "r12y create --title 'Recover checkout release safely' --dedupe 'slack:INC-4821'",
          target: "gsv",
        },
      },
      {
        id: "discover-release-agents",
        name: "Shell",
        arguments: { input: "proc agents --json", target: "gsv" },
      },
      {
        id: "delegate-release-research",
        name: "Shell",
        arguments: {
          input: "proc delegate --as incident-research --responsibility r12y:00000000-0000-4000-8000-000000000001 'Correlate every available read-only source for INC-4821 and recommend the safe recovery policy, including what evidence remains required.'",
          target: "gsv",
        },
      },
      {
        id: "delegate-release-rollback",
        name: "Shell",
        arguments: {
          input: "proc delegate --as rollback-operator --responsibility r12y:00000000-0000-4000-8000-000000000001 'Inspect checkout production and perform the safe rollback justified by the incident evidence. Never restart the bad release; report what still needs independent verification.'",
          target: "gsv",
        },
      },
      {
        id: "read-initial-release-health",
        name: "Read",
        arguments: {
          path: "/health/checkout.json",
          target: "checkout-monitor",
        },
      },
      {
        id: "wait-rollback-window",
        name: "Shell",
        arguments: {
          input: "r12y wait r12y:00000000-0000-4000-8000-000000000001 --until 2026-09-02T09:05:00.000Z --blocker 'awaiting independent rollback stability and approval gate'",
          target: "gsv",
        },
      },
      {
        id: "yield-rollback-window",
        name: "Shell",
        arguments: { input: "yield" },
      },
      {
        id: "read-rollback-window",
        name: "Read",
        arguments: {
          path: "/health/checkout.json",
          target: "checkout-monitor",
        },
      },
      {
        id: "delegate-approved-canary",
        name: "Shell",
        arguments: {
          input: "proc delegate --as canary-operator --responsibility r12y:00000000-0000-4000-8000-000000000001 'Check the authoritative checkout approval and, only if approved, deploy checkout-2026.09.02-rc2 to canary. Return the action without claiming health.'",
          target: "gsv",
        },
      },
      {
        id: "wait-canary-window",
        name: "Shell",
        arguments: {
          input: "r12y wait r12y:00000000-0000-4000-8000-000000000001 --until 2026-09-02T09:15:00.000Z --blocker 'awaiting independent canary health evidence'",
          target: "gsv",
        },
      },
      {
        id: "yield-canary-window",
        name: "Shell",
        arguments: { input: "yield" },
      },
      {
        id: "read-canary-window",
        name: "Read",
        arguments: {
          path: "/health/checkout.json",
          target: "checkout-monitor",
        },
      },
      {
        id: "delegate-promotion",
        name: "Shell",
        arguments: {
          input: "proc delegate --as promotion-operator --responsibility r12y:00000000-0000-4000-8000-000000000001 'Independent monitoring now shows checkout-2026.09.02-rc2 healthy in canary. Promote that candidate and report the action without claiming final stability.'",
          target: "gsv",
        },
      },
      {
        id: "wait-production-window",
        name: "Shell",
        arguments: {
          input: "r12y wait r12y:00000000-0000-4000-8000-000000000001 --until 2026-09-02T09:30:00.000Z --blocker 'awaiting post-promotion production stability evidence'",
          target: "gsv",
        },
      },
      {
        id: "yield-production-window",
        name: "Shell",
        arguments: { input: "yield" },
      },
      {
        id: "read-production-window",
        name: "Read",
        arguments: {
          path: "/health/checkout.json",
          target: "checkout-monitor",
        },
      },
      {
        id: "resolve-release-incident",
        name: "Shell",
        arguments: {
          input: "r12y resolve r12y:00000000-0000-4000-8000-000000000001 --json '{\"incident\":\"INC-4821\",\"release\":\"checkout-2026.09.02-rc2\",\"healthyWindows\":2}'",
          target: "gsv",
        },
      },
      {
        id: "finish-release-incident",
        name: "Shell",
        arguments: {
          input: "message send --message 'INC-4821 resolved: checkout-2026.09.02-rc2 is stable after rollback, approved canary, promotion, and independent production verification.' && yield",
        },
      },
    ];
    return shipCalls[resultCount] ?? { text: "Unexpected release scenario state" };
  }
  if (
    transcript.includes("Delegated task from ship (ship).")
    && transcript.includes("safely restore the last known healthy release")
  ) {
    if (resultCount === 0) {
      return {
        id: "discover-checkout-target",
        name: "Shell",
        arguments: { input: "targets list --json", target: "gsv" },
      };
    }
    if (resultCount === 1) {
      return {
        id: "inspect-checkout-status",
        name: "Shell",
        arguments: { input: "releasectl status", target: "checkout-production" },
      };
    }
    if (resultCount === 2) {
      return {
        id: "inspect-checkout-history",
        name: "Shell",
        arguments: { input: "releasectl history", target: "checkout-production" },
      };
    }
    if (resultCount === 3) {
      return {
        id: "read-checkout-errors",
        name: "Read",
        arguments: {
          path: "/var/log/checkout/error.log",
          target: "checkout-production",
        },
      };
    }
    if (resultCount === 4) {
      return {
        id: "rollback-checkout",
        name: "Shell",
        arguments: {
          input: "releasectl rollback checkout-2026.08.31",
          target: "checkout-production",
        },
      };
    }
    return {
      text: "Rolled checkout back from checkout-2026.09.01 to the previous healthy release checkout-2026.08.31 after confirming the schema checksum mismatch; independent health verification is pending.",
    };
  }
  if (transcript.includes("Delegated task from ship (ship).")) {
    return resultCount === 0
      ? {
        id: "read-incident-log",
        name: "Read",
        arguments: {
          path: "/var/log/deploy.log",
          target: "incident-server",
        },
      }
      : { text: "database migration checksum mismatch" };
  }
  if (transcript.includes("two consecutive healthy observation windows")) {
    if (resultCount === 0) {
      return {
        id: "acknowledge-checkout-incident",
        name: "Shell",
        arguments: {
          input: "message send --message 'Checkout incident acknowledged; investigating with operations.'",
        },
      };
    }
    if (resultCount === 1) {
      return {
        id: "create-checkout-responsibility",
        name: "Shell",
        arguments: {
          input: "r12y create --title 'Restore stable checkout service' --dedupe 'slack:checkout-incident'",
          target: "gsv",
        },
      };
    }
    if (resultCount === 2) {
      return {
        id: "discover-operations-agent",
        name: "Shell",
        arguments: { input: "proc agents --json", target: "gsv" },
      };
    }
    if (resultCount === 3) {
      return {
        id: "delegate-checkout-mitigation",
        name: "Shell",
        arguments: {
          input: "proc delegate --as ops --responsibility r12y:00000000-0000-4000-8000-000000000001 'Discover the production checkout target, diagnose the current incident, and safely restore the last known healthy release. Return the mitigation and evidence; do not claim independent health verification.'",
          target: "gsv",
        },
      };
    }
    if (resultCount === 4) {
      return {
        id: "inspect-initial-checkout-health",
        name: "Read",
        arguments: {
          path: "/checkout/health.json",
          target: "checkout-monitor",
        },
      };
    }
    if (resultCount === 5) {
      return {
        id: "wait-for-first-checkout-window",
        name: "Shell",
        arguments: {
          input: "r12y wait r12y:00000000-0000-4000-8000-000000000001 --until 2026-09-01T12:05:00.000Z --blocker 'awaiting independent stability evidence'",
          target: "gsv",
        },
      };
    }
    if (resultCount === 6) {
      return {
        id: "yield-for-first-checkout-window",
        name: "Shell",
        arguments: { input: "yield" },
      };
    }
    if (resultCount === 7) {
      return {
        id: "inspect-first-checkout-window",
        name: "Read",
        arguments: {
          path: "/checkout/health.json",
          target: "checkout-monitor",
        },
      };
    }
    if (resultCount === 8) {
      return {
        id: "wait-for-second-checkout-window",
        name: "Shell",
        arguments: {
          input: "r12y wait r12y:00000000-0000-4000-8000-000000000001 --until 2026-09-01T12:10:00.000Z --blocker 'awaiting second consecutive healthy window'",
          target: "gsv",
        },
      };
    }
    if (resultCount === 9) {
      return {
        id: "yield-for-second-checkout-window",
        name: "Shell",
        arguments: { input: "yield" },
      };
    }
    if (resultCount === 10) {
      return {
        id: "inspect-second-checkout-window",
        name: "Read",
        arguments: {
          path: "/checkout/health.json",
          target: "checkout-monitor",
        },
      };
    }
    if (resultCount === 11) {
      return {
        id: "resolve-checkout-incident",
        name: "Shell",
        arguments: {
          input: "r12y resolve r12y:00000000-0000-4000-8000-000000000001 --json '{\"release\":\"checkout-2026.08.31\",\"healthyWindows\":2,\"mitigation\":\"rollback\"}'",
          target: "gsv",
        },
      };
    }
    return {
      id: "finish-checkout-incident",
      name: "Shell",
      arguments: {
        input: "message send --message 'Checkout is stable on checkout-2026.08.31 after rollback; two healthy monitor windows confirmed.' && yield",
      },
    };
  }
  if (transcript.includes("slack:incident-42")) {
    if (resultCount === 0) {
      return {
        id: "create-incident-responsibility",
        name: "Shell",
        arguments: {
          input: "r12y create --title 'Investigate checkout deployment' --dedupe 'slack:incident-42'",
          target: "gsv",
        },
      };
    }
    if (resultCount === 1) {
      return {
        id: "delegate-incident",
        name: "Shell",
        arguments: {
          input: "proc delegate --as ops --responsibility r12y:00000000-0000-4000-8000-000000000001 'Read /var/log/deploy.log on target incident-server and return exactly the value after ROOT_CAUSE=.'",
          target: "gsv",
        },
      };
    }
    if (resultCount === 2) {
      return {
        id: "resolve-incident",
        name: "Shell",
        arguments: {
          input: "r12y resolve r12y:00000000-0000-4000-8000-000000000001 --json '{\"cause\":\"database migration checksum mismatch\"}'",
          target: "gsv",
        },
      };
    }
    return {
      id: "finish-incident",
      name: "Shell",
      arguments: {
        input: "message send --message 'checkout blocked: database migration checksum mismatch' && yield",
      },
    };
  }
  if (transcript.includes("/workspace/release.txt")) {
    if (resultCount === 0) {
      return {
        id: "read-release",
        name: "Read",
        arguments: {
          path: "/workspace/release.txt",
          target: "build-laptop",
        },
      };
    }
    if (resultCount === 1) {
      return {
        id: "deploy-release",
        name: "Shell",
        arguments: {
          input: "deploy release-2026.09.01",
          target: "deploy-server",
        },
      };
    }
    return {
      id: "finish-deploy",
      name: "Shell",
      arguments: {
        input: "message send --message 'release deployed' && yield",
      },
    };
  }

  return resultCount === 0
    ? {
      id: "inspect-targets",
      name: "Shell",
      arguments: {
        input: "targets list --json",
        target: "gsv",
      },
    }
    : {
      id: "finish-target",
      name: "Shell",
      arguments: {
        input: "message send --message 'gpu-lab ready' && yield",
      },
    };
}

function toolResultCount(messages: FakeMessage[]): number {
  return messages.filter(({ role }) => role === "tool").length;
}

function parsePort(argv: string[]): number {
  const index = argv.indexOf("--port");
  const value = Number(argv[index + 1]);
  if (index === -1 || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("Usage: fake-openai.ts --port PORT");
  }
  return value;
}

async function readBody(request: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function writeResponse(
  response: ServerResponse,
  model: string,
  selected: FakeResponse,
): void {
  if ("text" in selected) {
    const first = {
      id: "chatcmpl-worker-result",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{
        index: 0,
        delta: { role: "assistant", content: selected.text },
        finish_reason: null,
      }],
    };
    const terminal = {
      id: "chatcmpl-worker-result",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    writeEvents(response, first, terminal);
    return;
  }
  const call = selected;
  const first = {
    id: "chatcmpl-" + call.id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        }],
      },
      finish_reason: null,
    }],
  };
  const terminal = {
    id: "chatcmpl-" + call.id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };
  writeEvents(response, first, terminal);
}

function writeEvents(
  response: ServerResponse,
  first: JsonObject,
  terminal: JsonObject,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.end(
    "data: " + JSON.stringify(first)
      + "\n\ndata: " + JSON.stringify(terminal)
      + "\n\ndata: [DONE]\n\n",
  );
}
