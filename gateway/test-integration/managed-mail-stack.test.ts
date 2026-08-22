import type { TestHarness } from "wrangler";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { createManagedMailStackTestHarness } from "./harness";

const ACCOUNTS_WORKER = "gsv-accounts-test";
const EMAIL_WORKER = "gsv-managed-email-test";
const GATEWAY_WORKER = "gsv-managed-mail-stack";
const HANDLE = "managed-mail-stack";
const DELIVERY_ID = "managed-mail-stack-delivery";

describe("managed mail stack integration", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = createManagedMailStackTestHarness();
    await harness.listen();
    await harness.getWorker(ACCOUNTS_WORKER).applyD1Migrations("ACCOUNT_DB");
  });

  afterAll(async () => {
    await harness.close();
  });

  it("settles a durable Gateway mail intent through the Email Worker", async () => {
    const accounts = harness.getWorker(ACCOUNTS_WORKER);
    const createdResponse = await accounts.fetch(
      "http://localhost/admin/api/installations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
        },
        body: JSON.stringify({
          operationId: "operation_managed_mail_stack",
          handle: HANDLE,
        }),
      },
    );
    expect(createdResponse.status).toBe(201);
    // SAFETY: The account-service fixture returns this onboarding response contract.
    const created = await createdResponse.json() as {
      installation: { installationId: string };
      onboarding: { onboardingUrl: string };
    };
    const installationId = created.installation.installationId;
    const onboardingToken = new URL(created.onboarding.onboardingUrl).hash.slice(1);

    const socketResponse = await harness.getWorker(GATEWAY_WORKER).fetch(
      `https://${HANDLE}.gsv.space/ws`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(socketResponse.status).toBe(101);
    if (!socketResponse.webSocket) throw new Error("Managed WebSocket is unavailable");
    const socket = socketResponse.webSocket;
    socket.accept();

    try {
      await expectRpcOk(socket, "setup", "sys.setup", {
        username: "mail-owner",
        password: "mail-owner-password",
        onboardingToken,
      });
      await expectRpcOk(socket, "connect", "sys.connect", {
        protocol: 2,
        client: {
          id: "managed-mail-stack-test",
          version: "1.0.0",
          platform: "test",
          role: "user",
        },
        auth: {
          username: "mail-owner",
          password: "mail-owner-password",
        },
      });

      const sent = await expectRpcOk(socket, "send", "mail.send", {
        deliveryId: DELIVERY_ID,
        to: "recipient@example.com",
        subject: "Managed mail integration",
        text: "Hello from the managed mail stack.",
      });
      expect(sent.data).toMatchObject({
        ok: true,
        deliveryId: DELIVERY_ID,
        from: `${HANDLE}@gsv.space`,
        to: "recipient@example.com",
        subject: "Managed mail integration",
        replayed: false,
      });

      const status = await waitForAccepted(socket, DELIVERY_ID, "status");
      expect(status).toMatchObject({
        deliveryId: DELIVERY_ID,
        state: "accepted",
        from: `${HANDLE}@gsv.space`,
        to: "recipient@example.com",
        providerMessageId: expect.stringMatching(/^<[A-Za-z0-9]{36}@gsv\.space>$/),
      });

      const gateway = harness.getWorker<{
        KERNEL: DurableObjectNamespace<ManagedMailKernelRpc>;
        MANAGED_MAIL_OUTBOUND: Queue;
        STORAGE: R2Bucket;
      }>(GATEWAY_WORKER);
      const kernelStorage = await gateway.getDurableObjectStorage(
        "KERNEL",
        { name: installationId },
      );
      const kernelRows = await kernelStorage.exec(
        `SELECT outbound_id, fingerprint, body_path, body_digest, text_size,
                state, enqueue_attempts, enqueued_at, provider_message_id,
                completed_at
         FROM mail_outbound
         WHERE delivery_id = ?`,
        DELIVERY_ID,
      );
      expect(kernelRows).toHaveLength(1);
      expect(kernelRows[0]).toMatchObject({
        state: "accepted",
        text_size: 34,
        enqueue_attempts: 1,
        provider_message_id: status.providerMessageId,
      });
      expect(kernelRows[0].enqueued_at).toEqual(expect.any(Number));
      expect(kernelRows[0].completed_at).toEqual(expect.any(Number));

      const { STORAGE } = await gateway.getEnv();
      const bodyPath = String(kernelRows[0].body_path);
      const body = await STORAGE.get(
        `installations/${encodeURIComponent(installationId)}/${bodyPath.slice(1)}`,
      );
      expect(await body?.text()).toBe("Hello from the managed mail stack.");

      const mailStorage = await harness.getWorker(EMAIL_WORKER)
        .getDurableObjectStorage("MAIL_INSTALLATIONS", { name: installationId });
      const deliveryRows = await mailStorage.exec(
        `SELECT outbound_id, fingerprint, expected_from, state, text_size,
                provider_message_id, callback_attempts, callback_completed_at
         FROM mail_outbound_deliveries`,
      );
      expect(deliveryRows).toEqual([expect.objectContaining({
        outbound_id: kernelRows[0].outbound_id,
        fingerprint: kernelRows[0].fingerprint,
        expected_from: `${HANDLE}@gsv.space`,
        state: "accepted",
        text_size: 34,
        provider_message_id: status.providerMessageId,
        callback_attempts: 1,
      })]);
      expect(deliveryRows[0].callback_completed_at).toEqual(expect.any(Number));

      const recoveryOutboundId = "mail-outbound:recovery-integration";
      const recoveryDeliveryId = "managed-mail-recovery-delivery";
      const recoveryFingerprint = `sha256:${"c".repeat(64)}`;
      const recoveryText = "Recover this durable mail intent.";
      const recoveryBodyDigest = await sha256(recoveryText);
      const recoveryBodyPath = `/home/mail-owner/.gsv/mail/outbox/${recoveryOutboundId}/message.txt`;
      const recoveryCreatedAt = Date.now();
      await kernelStorage.exec(
        `INSERT INTO mail_outbound (
           outbound_id, owner_uid, delivery_id, fingerprint,
           from_address, to_address, subject, body_digest, body_path, text_size,
           state, enqueue_attempts, enqueue_next_at, created_at, queued_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
        recoveryOutboundId,
        1000,
        recoveryDeliveryId,
        recoveryFingerprint,
        `${HANDLE}@gsv.space`,
        "recovery@example.com",
        "Recovered mail",
        recoveryBodyDigest,
        recoveryBodyPath,
        new TextEncoder().encode(recoveryText).byteLength,
        recoveryCreatedAt,
        recoveryCreatedAt,
        recoveryCreatedAt,
      );
      await STORAGE.put(
        `installations/${encodeURIComponent(installationId)}/${recoveryBodyPath.slice(1)}`,
        recoveryText,
      );
      const gatewayEnv = await gateway.getEnv();
      await gatewayEnv.KERNEL.getByName(installationId)
        .onManagedOutboundEnqueue(recoveryOutboundId);

      const recoveryStatus = await waitForAccepted(
        socket,
        recoveryDeliveryId,
        "recovery-status",
      );
      expect(recoveryStatus).toMatchObject({
        state: "accepted",
        from: `${HANDLE}@gsv.space`,
        to: "recovery@example.com",
      });
      await expect(kernelStorage.exec(
        `SELECT state, enqueue_attempts, enqueued_at, completed_at
         FROM mail_outbound
         WHERE outbound_id = ?`,
        recoveryOutboundId,
      )).resolves.toEqual([expect.objectContaining({
        state: "accepted",
        enqueue_attempts: 1,
        enqueued_at: expect.any(Number),
        completed_at: expect.any(Number),
      })]);
      await expect(mailStorage.exec(
        `SELECT state, provider_message_id, callback_completed_at
         FROM mail_outbound_deliveries
         WHERE outbound_id = ?`,
        recoveryOutboundId,
      )).resolves.toEqual([expect.objectContaining({
        state: "accepted",
        provider_message_id: recoveryStatus.providerMessageId,
        callback_completed_at: expect.any(Number),
      })]);

      await setInstallationState(accounts, installationId, "restricted");
      const inactiveOutboundId = "mail-outbound:inactive-integration";
      const inactiveFingerprint = `sha256:${"a".repeat(64)}`;
      const now = Date.now();
      await kernelStorage.exec(
        `INSERT INTO mail_outbound (
           outbound_id, owner_uid, delivery_id, fingerprint,
           from_address, to_address, subject, body_digest, body_path, text_size,
           state, enqueue_attempts, created_at, queued_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
        inactiveOutboundId,
        1000,
        "managed-mail-inactive-delivery",
        inactiveFingerprint,
        `${HANDLE}@gsv.space`,
        "recipient@example.com",
        "Inactive installation",
        `sha256:${"b".repeat(64)}`,
        `/home/mail-owner/.gsv/mail/outbox/${inactiveOutboundId}/message.txt`,
        1,
        now,
        now,
      );
      await gatewayEnv.MANAGED_MAIL_OUTBOUND.send({
        version: 1,
        installationId,
        outboundId: inactiveOutboundId,
        fingerprint: inactiveFingerprint,
      });

      const inactiveDeadline = Date.now() + 20_000;
      let inactiveRows: MailOutboundRow[] = [];
      while (Date.now() < inactiveDeadline) {
        inactiveRows = await kernelStorage.exec(
          `SELECT state, error_code, completed_at
           FROM mail_outbound
           WHERE outbound_id = ?`,
          inactiveOutboundId,
        );
        if (inactiveRows[0]?.state === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(inactiveRows).toEqual([expect.objectContaining({
        state: "failed",
        error_code: "installation_inactive",
        completed_at: expect.any(Number),
      })]);
      await expect(mailStorage.exec(
        `SELECT outbound_id, expected_from, state, error_code, callback_completed_at
         FROM mail_outbound_deliveries
         WHERE outbound_id = ?`,
        inactiveOutboundId,
      )).resolves.toEqual([expect.objectContaining({
        outbound_id: inactiveOutboundId,
        expected_from: null,
        state: "failed",
        error_code: "installation_inactive",
        callback_completed_at: expect.any(Number),
      })]);

      await setInstallationState(accounts, installationId, "active");
      const inactiveStatus = await expectRpcOk(
        socket,
        "inactive-status",
        "mail.status",
        { deliveryId: "managed-mail-inactive-delivery" },
      );
      expect(inactiveStatus.data).toMatchObject({
        outbound: {
          state: "failed",
          errorCode: "installation_inactive",
        },
      });

      const missingBodyOutboundId = "mail-outbound:missing-body-integration";
      const missingBodyFingerprint = `sha256:${"d".repeat(64)}`;
      const missingBodyDeliveryId = "managed-mail-missing-body-delivery";
      const missingBodyAt = Date.now();
      await kernelStorage.exec(
        `INSERT INTO mail_outbound (
           outbound_id, owner_uid, delivery_id, fingerprint,
           from_address, to_address, subject, body_digest, body_path, text_size,
           state, enqueue_attempts, enqueued_at, created_at, queued_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?)`,
        missingBodyOutboundId,
        1000,
        missingBodyDeliveryId,
        missingBodyFingerprint,
        `${HANDLE}@gsv.space`,
        "recipient@example.com",
        "Missing body",
        `sha256:${"e".repeat(64)}`,
        `/home/mail-owner/.gsv/mail/outbox/${missingBodyOutboundId}/message.txt`,
        1,
        missingBodyAt,
        missingBodyAt,
        missingBodyAt,
      );
      await gatewayEnv.MANAGED_MAIL_OUTBOUND.send({
        version: 1,
        installationId,
        outboundId: missingBodyOutboundId,
        fingerprint: missingBodyFingerprint,
      });

      const missingBodyDeadline = Date.now() + 20_000;
      let missingBodyRows: MailOutboundRow[] = [];
      while (Date.now() < missingBodyDeadline) {
        missingBodyRows = await kernelStorage.exec(
          `SELECT state, error_code, completed_at
           FROM mail_outbound
           WHERE outbound_id = ?`,
          missingBodyOutboundId,
        );
        if (missingBodyRows[0]?.state === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(missingBodyRows).toEqual([expect.objectContaining({
        state: "failed",
        error_code: "body_unavailable",
        completed_at: expect.any(Number),
      })]);
      await expect(mailStorage.exec(
        `SELECT expected_from, state, error_code, callback_attempts,
                callback_completed_at
         FROM mail_outbound_deliveries
         WHERE outbound_id = ?`,
        missingBodyOutboundId,
      )).resolves.toEqual([expect.objectContaining({
        expected_from: `${HANDLE}@gsv.space`,
        state: "failed",
        error_code: "body_unavailable",
        callback_attempts: 0,
        callback_completed_at: expect.any(Number),
      })]);

      const absentInstallationId = "installation-missing-directory-integration";
      const absentOutboundId = "mail-outbound:missing-directory-integration";
      const absentFingerprint = `sha256:${"f".repeat(64)}`;
      const kernelIdsBefore = (await gateway.listDurableObjectIds("KERNEL")).sort();
      await gatewayEnv.MANAGED_MAIL_OUTBOUND.send({
        version: 1,
        installationId: absentInstallationId,
        outboundId: absentOutboundId,
        fingerprint: absentFingerprint,
      });
      const absentStorage = await harness.getWorker(EMAIL_WORKER)
        .getDurableObjectStorage("MAIL_INSTALLATIONS", {
          name: absentInstallationId,
        });
      const absentDeadline = Date.now() + 20_000;
      let absentRows: MailOutboundRow[] = [];
      while (Date.now() < absentDeadline) {
        absentRows = await absentStorage.exec(
          `SELECT expected_from, state, error_code, claim_attempts,
                  callback_attempts, callback_next_attempt_at,
                  callback_completed_at
           FROM mail_outbound_deliveries
           WHERE outbound_id = ?`,
          absentOutboundId,
        );
        if (absentRows[0]?.callback_completed_at) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(absentRows).toEqual([expect.objectContaining({
        expected_from: null,
        state: "failed",
        error_code: "installation_inactive",
        claim_attempts: 1,
        callback_attempts: 1,
        callback_next_attempt_at: null,
        callback_completed_at: expect.any(Number),
      })]);
      expect((await gateway.listDurableObjectIds("KERNEL")).sort())
        .toEqual(kernelIdsBefore);
    } finally {
      socket.close(1000, "test complete");
    }
  });
});

type RpcResponse = {
  type: "res";
  id: string;
  ok: boolean;
  data?: { outbound?: MailStatus | null };
  error?: { code?: number; message: string };
};

type MailStatus = {
  deliveryId: string;
  state: string;
  from: string;
  to: string;
  providerMessageId?: string;
};

type MailOutboundRow = {
  state?: string;
  error_code?: string | null;
  completed_at?: number | null;
  expected_from?: string | null;
  claim_attempts?: number;
  callback_attempts?: number;
  callback_next_attempt_at?: number | null;
  callback_completed_at?: number | null;
};

type RpcArgs = Record<string, JsonValue>;
type RpcSocket = {
  addEventListener(type: "message", listener: (event: { data: string }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: string }) => void): void;
};

interface ManagedMailKernelRpc extends Rpc.DurableObjectBranded {
  onManagedOutboundEnqueue(outboundId: string): Promise<void>;
}

type HarnessWorker = ReturnType<TestHarness["getWorker"]>;
type HarnessResponse = Awaited<ReturnType<HarnessWorker["fetch"]>>;
type HarnessWebSocket = NonNullable<HarnessResponse["webSocket"]>;
type AdminWorker = {
  fetch(
    input: string,
    init: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
    },
  ): Promise<{ status: number }>;
};

async function expectRpcOk(
  socket: HarnessWebSocket,
  id: string,
  call: string,
  args: RpcArgs,
): Promise<RpcResponse> {
  const response = await rpc(socket, id, call, args);
  expect(response).toMatchObject({ type: "res", id, ok: true });
  return response;
}

async function rpc(
  socket: HarnessWebSocket,
  id: string,
  call: string,
  args: RpcArgs,
): Promise<RpcResponse> {
  // SAFETY: The Workers test WebSocket exposes string message events.
  const eventSocket = socket as RpcSocket;
  const response = new Promise<RpcResponse>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onMessage = (event: { data: string }) => {
      // SAFETY: The managed gateway sends JSON-encoded RPC response frames.
      const frame = JSON.parse(event.data) as RpcResponse;
      if (frame.type !== "res" || frame.id !== id) return;
      eventSocket.removeEventListener("message", onMessage);
      clearTimeout(timeout);
      resolve(frame);
    };
    eventSocket.addEventListener("message", onMessage);
    timeout = setTimeout(() => {
      eventSocket.removeEventListener("message", onMessage);
      reject(new Error(`Timed out waiting for ${call}`));
    }, 10_000);
  });
  socket.send(JSON.stringify({ type: "req", id, call, args }));
  return await response;
}

async function waitForAccepted(
  socket: HarnessWebSocket,
  deliveryId: string,
  requestIdPrefix: string,
): Promise<MailStatus> {
  const deadline = Date.now() + 20_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const response = await expectRpcOk(
      socket,
      `${requestIdPrefix}-${attempt}`,
      "mail.status",
      { deliveryId },
    );
    const status = response.data?.outbound;
    if (status?.state === "accepted") return status;
    if (status && status.state !== "queued" && status.state !== "staging") {
      throw new Error(`Managed mail reached unexpected state ${status.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for managed mail completion");
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return `sha256:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function setInstallationState(
  accounts: AdminWorker,
  installationId: string,
  state: "active" | "restricted",
): Promise<void> {
  const response = await accounts.fetch(
    `http://localhost/admin/api/installations/${installationId}/lifecycle`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({ state }),
    },
  );
  expect(response.status).toBe(200);
}
