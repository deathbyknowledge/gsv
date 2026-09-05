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
  const competingIncident = selectCompetingIncidentResponse(
    transcript,
    resultCount,
  );
  if (competingIncident) return competingIncident;
  const serviceAccount = selectServiceAccountResponse(transcript, resultCount);
  if (serviceAccount) return serviceAccount;
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
        id: "yield-for-release-workers",
        name: "Shell",
        arguments: { input: "yield" },
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
        id: "yield-for-canary-worker",
        name: "Shell",
        arguments: { input: "yield" },
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
        id: "yield-for-promotion-worker",
        name: "Shell",
        arguments: { input: "yield" },
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
        id: "yield-for-checkout-worker",
        name: "Shell",
        arguments: { input: "yield" },
      };
    }
    if (resultCount === 5) {
      return {
        id: "inspect-initial-checkout-health",
        name: "Read",
        arguments: {
          path: "/checkout/health.json",
          target: "checkout-monitor",
        },
      };
    }
    if (resultCount === 6) {
      return {
        id: "wait-for-first-checkout-window",
        name: "Shell",
        arguments: {
          input: "r12y wait r12y:00000000-0000-4000-8000-000000000001 --until 2026-09-01T12:05:00.000Z --blocker 'awaiting independent stability evidence'",
          target: "gsv",
        },
      };
    }
    if (resultCount === 7) {
      return {
        id: "yield-for-first-checkout-window",
        name: "Shell",
        arguments: { input: "yield" },
      };
    }
    if (resultCount === 8) {
      return {
        id: "inspect-first-checkout-window",
        name: "Read",
        arguments: {
          path: "/checkout/health.json",
          target: "checkout-monitor",
        },
      };
    }
    if (resultCount === 9) {
      return {
        id: "wait-for-second-checkout-window",
        name: "Shell",
        arguments: {
          input: "r12y wait r12y:00000000-0000-4000-8000-000000000001 --until 2026-09-01T12:10:00.000Z --blocker 'awaiting second consecutive healthy window'",
          target: "gsv",
        },
      };
    }
    if (resultCount === 10) {
      return {
        id: "yield-for-second-checkout-window",
        name: "Shell",
        arguments: { input: "yield" },
      };
    }
    if (resultCount === 11) {
      return {
        id: "inspect-second-checkout-window",
        name: "Read",
        arguments: {
          path: "/checkout/health.json",
          target: "checkout-monitor",
        },
      };
    }
    if (resultCount === 12) {
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
        id: "yield-for-incident-worker",
        name: "Shell",
        arguments: { input: "yield" },
      };
    }
    if (resultCount === 3) {
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

function selectCompetingIncidentResponse(
  transcript: string,
  resultCount: number,
): FakeResponse | undefined {
  const initialIncident = transcriptFact(transcript, "initial_incident");
  const initialService = transcriptFact(transcript, "initial_service");
  const initialChange = transcriptFact(transcript, "initial_change");
  const priorityIncident = transcriptFact(transcript, "priority_incident");
  const priorityService = transcriptFact(transcript, "priority_service");
  const priorityChange = transcriptFact(transcript, "priority_change");

  if (transcript.includes("read-only competing-incident triage Process")) {
    const incident = requireFakeFact(initialIncident, "initial_incident");
    const service = requireFakeFact(initialService, "initial_service");
    const calls: FakeToolCall[] = [
      fakeShell("competing-triage-targets", "targets list --json", "gsv"),
      fakeRead(
        "competing-triage-runbook",
        "/runbooks/change-window.md",
        "incident-coordination-laptop",
      ),
      fakeRead(
        "competing-triage-monitor",
        `/health/${service}.json`,
        `${service}-monitor`,
      ),
      fakeShell(
        "competing-triage-diagnostics",
        `incidentctl summary ${incident}`,
        `${service}-diagnostics`,
      ),
    ];
    if (transcript.includes(`${service}-customer-browser`)) {
      calls.push(fakeRead(
        "competing-triage-customer-impact",
        `/pages/${incident}.txt`,
        `${service}-customer-browser`,
      ));
    }
    if (transcript.includes("shared-dependency-diagnostics")) {
      calls.push(fakeRead(
        "competing-triage-shared-dependency",
        "/diagnostics/shared.json",
        "shared-dependency-diagnostics",
      ));
    }
    return calls[resultCount] ?? {
      text: `Correlated current evidence for ${incident} on ${service}. The change ${initialChange ?? "identified in diagnostics"} may be prepared, but the shared change window has not granted execution authority.`,
    };
  }

  if (transcript.includes("bounded change planner for the initial incident")) {
    const incident = requireFakeFact(initialIncident, "initial_incident");
    const service = requireFakeFact(initialService, "initial_service");
    const change = requireFakeFact(initialChange, "initial_change");
    const calls: FakeToolCall[] = [
      fakeShell("competing-planner-targets", "targets list --json", "gsv"),
      fakeShell(
        "competing-planner-status",
        `incidentctl status ${incident}`,
        `${service}-change-control`,
      ),
      fakeShell(
        "competing-planner-prepare",
        `incidentctl prepare ${change}`,
        `${service}-change-control`,
      ),
    ];
    return calls[resultCount] ?? {
      text: `Prepared ${change} for ${incident}; no production change was applied because execution authority is still absent.`,
    };
  }

  if (transcript.includes("least-privilege competing-incident priority responder")) {
    const incident = requireFakeFact(priorityIncident, "priority_incident");
    const service = requireFakeFact(priorityService, "priority_service");
    const change = requireFakeFact(priorityChange, "priority_change");
    const calls: FakeToolCall[] = [
      fakeShell("competing-responder-targets", "targets list --json", "gsv"),
    ];
    if (transcript.includes(`${service}-approval`)) {
      calls.push(fakeRead(
        "competing-responder-approval",
        `/approvals/${incident}.json`,
        `${service}-approval`,
      ));
    }
    calls.push(
      fakeRead(
        "competing-responder-monitor",
        `/health/${service}.json`,
        `${service}-monitor`,
      ),
      fakeShell(
        "competing-responder-inspect",
        `incidentctl inspect ${incident}`,
        `${service}-control`,
      ),
      fakeShell(
        "competing-responder-contain",
        `incidentctl contain ${incident} --change ${change}`,
        `${service}-control`,
      ),
    );
    return calls[resultCount] ?? {
      text: `Contained ${incident} with ${change}; independent recovery evidence is still required.`,
    };
  }

  if (!transcript.includes("Initial facts: initial_incident=")) return undefined;
  const incident = requireFakeFact(initialIncident, "initial_incident");
  const service = requireFakeFact(initialService, "initial_service");
  const change = requireFakeFact(initialChange, "initial_change");
  const decisionAt = requireFakeFact(
    transcriptFact(transcript, "decision_at"),
    "decision_at",
  );
  const delegateSynchronizationId = "competing-ship-yield-initial-results";
  const synchronizedInitialDelegates = transcript.includes(
    `"id":"${delegateSynchronizationId}"`,
  );
  const decisionDeferred = transcript.includes(
    '"id":"competing-ship-wait-decision"',
  );
  const decisionYielded = transcript.includes(
    '"id":"competing-ship-yield-decision"',
  );
  const initialDelegatesComplete = [
    "Delegated task from process `proc:" + service + "-triage` finished.",
    "Delegated task from process `proc:" + service + "-planner` finished.",
  ].every((message) => transcript.includes(message));
  if (
    !priorityIncident
    && decisionDeferred
    && initialDelegatesComplete
    && !synchronizedInitialDelegates
  ) {
    return fakeShell(delegateSynchronizationId, "yield");
  }
  const scriptedResultCount = resultCount
    - (synchronizedInitialDelegates && decisionYielded ? 1 : 0);
  const calls: FakeToolCall[] = [
    fakeShell(
      "competing-ship-ack",
      `message send --message 'Acknowledged ${incident}; I am investigating and will preserve the shared change window until the priority decision.'`,
    ),
    fakeShell(
      "competing-ship-create-initial",
      `r12y create --title 'Coordinate ${incident} on ${service}' --priority high --dedupe 'slack:${incident}'`,
      "gsv",
    ),
    fakeShell("competing-ship-agents", "proc agents --json", "gsv"),
    fakeShell(
      "competing-ship-delegate-triage",
      `proc delegate --as initial-triage --responsibility r12y:00000000-0000-4000-8000-000000000001 'Investigate without mutation. Facts: initial_incident=${incident} initial_service=${service} initial_change=${change}.'`,
      "gsv",
    ),
    fakeShell(
      "competing-ship-delegate-planner",
      `proc delegate --as initial-planner --responsibility r12y:00000000-0000-4000-8000-000000000001 'Prepare but do not apply the queued change. Facts: initial_incident=${incident} initial_service=${service} initial_change=${change}.'`,
      "gsv",
    ),
    fakeShell("competing-ship-yield-initial-delegates", "yield"),
    fakeShell(
      "competing-ship-wait-decision",
      `r12y wait r12y:00000000-0000-4000-8000-000000000001 --until ${decisionAt} --blocker 'awaiting shared change-window priority decision'`,
      "gsv",
    ),
    fakeShell("competing-ship-yield-decision", "yield"),
  ];
  if (priorityIncident && priorityService && priorityChange) {
    const verificationAt = requireFakeFact(
      transcriptFact(transcript, "verification_at"),
      "verification_at",
    );
    calls.push(
      fakeRead(
        "competing-ship-read-initial-priority-window",
        `/health/${service}.json`,
        `${service}-monitor`,
      ),
      fakeRead(
        "competing-ship-read-priority-window",
        `/health/${priorityService}.json`,
        `${priorityService}-monitor`,
      ),
      fakeShell(
        "competing-ship-downgrade-initial",
        `r12y update r12y:00000000-0000-4000-8000-000000000001 --json '{"priority":"low","blocker":"superseded by ${priorityIncident}"}'`,
        "gsv",
      ),
      fakeShell(
        "competing-ship-cancel-initial",
        `r12y cancel r12y:00000000-0000-4000-8000-000000000001 --json '{"supersededBy":"${priorityIncident}","changeApplied":false}'`,
        "gsv",
      ),
      fakeShell(
        "competing-ship-create-priority",
        `r12y create --title 'Contain ${priorityIncident} on ${priorityService}' --priority critical --dedupe 'incident:${priorityIncident}'`,
        "gsv",
      ),
      fakeShell(
        "competing-ship-delegate-priority",
        `proc delegate --as priority-responder --responsibility r12y:00000000-0000-4000-8000-000000000002 'Contain only the selected critical incident. Facts: priority_incident=${priorityIncident} priority_service=${priorityService} priority_change=${priorityChange}.'`,
        "gsv",
      ),
      fakeShell("competing-ship-yield-priority-delegate", "yield"),
      fakeShell(
        "competing-ship-wait-verification",
        `r12y wait r12y:00000000-0000-4000-8000-000000000002 --until ${verificationAt} --blocker 'awaiting independent dual-service recovery evidence'`,
        "gsv",
      ),
      fakeShell("competing-ship-yield-verification", "yield"),
      fakeRead(
        "competing-ship-verify-priority",
        `/health/${priorityService}.json`,
        `${priorityService}-monitor`,
      ),
      fakeRead(
        "competing-ship-verify-initial",
        `/health/${service}.json`,
        `${service}-monitor`,
      ),
      fakeShell(
        "competing-ship-resolve-priority",
        `r12y resolve r12y:00000000-0000-4000-8000-000000000002 --json '{"incident":"${priorityIncident}","change":"${priorityChange}","initialIncident":"${incident}","verification":"dual-service"}'`,
        "gsv",
      ),
      fakeShell(
        "competing-ship-finish",
        `message send --message '${priorityIncident} resolved with ${priorityChange}; ${incident} is stable through the shared recovery and its superseded ${change} was not applied.' && yield`,
      ),
    );
  }
  return calls[scriptedResultCount]
    ?? { text: "Unexpected competing-incident state" };
}

function selectServiceAccountResponse(
  transcript: string,
  resultCount: number,
): FakeResponse | undefined {
  const requestId = transcriptFact(transcript, "request_id");
  const externalHandle = transcriptFact(transcript, "external_handle");
  const claimedEmail = transcriptFact(transcript, "claimed_email");
  const channelId = transcriptFact(transcript, "channel_id");
  const role = transcriptFact(transcript, "requested_role")
    ?? transcriptFact(transcript, "role");
  const securityTicket = transcriptFact(transcript, "security_ticket");
  const contractId = transcriptFact(transcript, "contract_id");
  const sponsorId = transcriptFact(transcript, "sponsor_id");
  const memberId = transcriptFact(transcript, "member_id");
  const disposition = transcriptFact(transcript, "disposition");

  if (transcript.includes("read-only service-account identity reviewer")) {
    const request = requireFakeFact(requestId, "request_id");
    const handle = requireFakeFact(externalHandle, "external_handle");
    const calls: FakeToolCall[] = [
      fakeShell("service-identity-targets", "targets list --json", "gsv"),
      fakeRead(
        "service-identity-request",
        `/requests/${request}.json`,
        "access-request-archive",
      ),
      fakeRead(
        "service-identity-directory",
        `/directory/${handle}.json`,
        "identity-directory-browser",
      ),
    ];
    if (transcript.includes("security-ticket-system")) {
      calls.push(fakeRead(
        "service-identity-security",
        `/tickets/${requireFakeFact(securityTicket, "security_ticket")}.json`,
        "security-ticket-system",
      ));
    }
    if (transcript.includes("contract-browser")) {
      calls.push(fakeRead(
        "service-identity-contract",
        `/contracts/${requireFakeFact(contractId, "contract_id")}.txt`,
        "contract-browser",
      ));
    }
    if (transcript.includes("manager-directory")) {
      calls.push(fakeRead(
        "service-identity-sponsor",
        `/sponsors/${requireFakeFact(sponsorId, "sponsor_id")}.json`,
        "manager-directory",
      ));
    }
    return calls[resultCount] ?? {
      text: `Correlated request ${request}, canonical directory identity, and all offered scope evidence. Claimed identity ${claimedEmail ?? "was checked"}; authoritative approval is still required.`,
    };
  }

  if (transcript.includes("least-privilege Slack service-account administrator")) {
    const request = requireFakeFact(requestId, "request_id");
    const decision = requireFakeFact(disposition, "disposition");
    const calls: FakeToolCall[] = [
      fakeShell("service-admin-targets", "targets list --json", "gsv"),
      fakeRead(
        "service-admin-decision",
        `/approvals/${request}.json`,
        "service-approval-workstation",
      ),
    ];
    if (decision === "approved") {
      const member = requireFakeFact(memberId, "member_id");
      const channel = requireFakeFact(channelId, "channel_id");
      const requestedRole = requireFakeFact(role, "requested_role");
      calls.push(
        fakeShell(
          "service-admin-user",
          `slack user show ${member}`,
          "slack-service-account",
        ),
        fakeShell(
          "service-admin-channel",
          `slack channel show ${channel}`,
          "slack-service-account",
        ),
        fakeShell(
          "service-admin-grant",
          `slack access grant --request ${request} --user ${member} --channel ${channel} --role ${requestedRole}`,
          "slack-service-account",
        ),
      );
      return calls[resultCount] ?? {
        text: `Issued the exact approved grant for ${request} once. The command is not membership confirmation; await the independent audit.`,
      };
    }
    return calls[resultCount] ?? {
      text: `Read authoritative disposition ${decision} for ${request}; made no service-account mutation.`,
    };
  }

  if (!transcript.includes("Request facts: request_id=")) return undefined;
  const request = requireFakeFact(requestId, "request_id");
  const approvalAt = requireFakeFact(
    transcriptFact(transcript, "approval_at"),
    "approval_at",
  );
  const calls: FakeToolCall[] = [
    fakeShell(
      "service-ship-ack",
      `message send --message 'Acknowledged access request ${request}; I am verifying identity and will wait for the authoritative decision.'`,
    ),
    fakeShell(
      "service-ship-create",
      `r12y create --title 'Process access request ${request}' --priority normal --dedupe 'slack:${request}'`,
      "gsv",
    ),
    fakeShell("service-ship-agents", "proc agents --json", "gsv"),
    fakeShell(
      "service-ship-delegate-identity",
      `proc delegate --as identity-reviewer --responsibility r12y:00000000-0000-4000-8000-000000000001 'Verify identity and scope read-only. Facts: request_id=${request} external_handle=${requireFakeFact(externalHandle, "external_handle")} claimed_email=${requireFakeFact(claimedEmail, "claimed_email")} channel_id=${requireFakeFact(channelId, "channel_id")} requested_role=${requireFakeFact(role, "requested_role")} security_ticket=${requireFakeFact(securityTicket, "security_ticket")} contract_id=${requireFakeFact(contractId, "contract_id")} sponsor_id=${requireFakeFact(sponsorId, "sponsor_id")}.'`,
      "gsv",
    ),
    fakeShell("service-ship-yield-identity", "yield"),
    fakeShell(
      "service-ship-wait-decision",
      `r12y wait r12y:00000000-0000-4000-8000-000000000001 --until ${approvalAt} --blocker 'awaiting authoritative service access decision'`,
      "gsv",
    ),
    fakeShell("service-ship-yield-decision", "yield"),
  ];
  if (disposition && memberId && channelId && role) {
    const reason = transcriptDecisionReason(transcript);
    calls.push(fakeShell(
      "service-ship-delegate-admin",
      `proc delegate --as service-access-admin --responsibility r12y:00000000-0000-4000-8000-000000000001 'Apply the authoritative disposition without exceeding its scope. Facts: disposition=${disposition} request_id=${request} member_id=${memberId} channel_id=${channelId} requested_role=${role}.'`,
      "gsv",
    ));
    calls.push(fakeShell("service-ship-yield-admin", "yield"));
    if (disposition === "approved") {
      const confirmationAt = requireFakeFact(
        transcriptFact(transcript, "confirmation_at"),
        "confirmation_at",
      );
      calls.push(
        fakeShell(
          "service-ship-wait-confirmation",
          `r12y wait r12y:00000000-0000-4000-8000-000000000001 --until ${confirmationAt} --blocker 'awaiting independent membership confirmation'`,
          "gsv",
        ),
        fakeShell("service-ship-yield-confirmation", "yield"),
        fakeRead(
          "service-ship-read-audit",
          `/audit/${request}.json`,
          "service-membership-audit",
        ),
        fakeShell(
          "service-ship-resolve",
          `r12y resolve r12y:00000000-0000-4000-8000-000000000001 --json '{"disposition":"granted","requestId":"${request}","memberId":"${memberId}","channelId":"${channelId}"}'`,
          "gsv",
        ),
        fakeShell(
          "service-ship-finish-approved",
          `message send --message 'Access request ${request} completed: independent audit confirms ${memberId} is active in ${channelId} with role ${role}.' && yield`,
        ),
      );
    } else {
      calls.push(
        fakeShell(
          "service-ship-cancel",
          `r12y cancel r12y:00000000-0000-4000-8000-000000000001 --json '${JSON.stringify({ disposition, requestId: request, reason })}'`,
          "gsv",
        ),
        fakeShell(
          "service-ship-finish-non-approved",
          `message send --message 'Access request ${request} ${disposition}: ${reason}. No service mutation was made.' && yield`,
        ),
      );
    }
  }
  return calls[resultCount] ?? { text: "Unexpected service-account state" };
}

function fakeShell(id: string, input: string, target?: string): FakeToolCall {
  return {
    id,
    name: "Shell",
    arguments: target === undefined ? { input } : { input, target },
  };
}

function fakeRead(id: string, path: string, target: string): FakeToolCall {
  return { id, name: "Read", arguments: { path, target } };
}

function transcriptFact(transcript: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?:^|[^A-Za-z0-9_])${escaped}=([A-Za-z0-9@._:-]+)`,
  ).exec(transcript);
  return match?.[1]?.replace(/[.,;]+$/, "");
}

function transcriptDecisionReason(transcript: string): string {
  return /Reason: (.*?)\. Delegate a bounded/.exec(transcript)?.[1]
    ?? "authoritative decision did not approve access";
}

function requireFakeFact(value: string | undefined, key: string): string {
  if (value === undefined) throw new Error(`Missing fake scenario fact: ${key}`);
  return value;
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
