import { describe, expect, it } from "vitest";
import type { ProcessEventDeliverArgs, ProcessInput } from "../protocol/process-frames";
import { initProcess, makeReq, ROOT_IDENTITY, runInProcess } from "./do-test-harness";

const CLIENT = { kind: "client", connectionId: "client-1" } as const;

function input(eventId: string, message: ProcessInput, busy: "interrupt" | "after"): ProcessEventDeliverArgs {
  return { eventId, input: message, admission: { idle: "start", busy } };
}

describe("messages delivered from the event log", () => {
  it("lets a person's message stop the active run and start its own under the run it carries", async () => {
    const stub = await initProcess("mech-input-interrupt", ROOT_IDENTITY);
    await expect(stub.deliverEvent(input("evt_1:proc:mech-input-interrupt", { message: "Plan the trip.", origin: CLIENT }, "interrupt")))
      .resolves.toEqual({ eventId: "evt_1:proc:mech-input-interrupt", runId: "evt_1:proc:mech-input-interrupt", queued: false });

    const interaction = { conversationId: "conversation-1", messageId: "msg-2" };
    await expect(stub.deliverEvent(input("evt_2:personal:0", { message: "Actually, book it.", origin: CLIENT, interaction, runId: "run:msg-2" }, "interrupt")))
      .resolves.toEqual({ eventId: "evt_2:personal:0", runId: "run:msg-2", queued: false });

    await runInProcess(stub, (process) => {
      expect(process.runs.active).toMatchObject({ runId: "run:msg-2", conversationId: "conversation-1", inputMessageId: "msg-2" });
      expect(process.store.queue.queueSize()).toBe(0);
      expect(process.store.messages.getMessages().filter((message) => message.role === "user").map((message) => message.runId))
        .toEqual(["evt_1:proc:mech-input-interrupt", "run:msg-2"]);
      expect(process.controller.isAbortedRun("evt_1:proc:mech-input-interrupt")).toBe(true);
    });
  });

  it("lets a process's message wait its turn as a run of its own", async () => {
    const stub = await initProcess("mech-input-after", ROOT_IDENTITY);
    await stub.deliverEvent(input("evt_1:proc:mech-input-after", { message: "First.", origin: CLIENT }, "interrupt"));
    const fromProcess = { kind: "process", sourcePid: "parent" } as const;

    await expect(stub.deliverEvent(input("evt_2:proc:mech-input-after", { message: "Next, the logs.", origin: fromProcess }, "after")))
      .resolves.toEqual({ eventId: "evt_2:proc:mech-input-after", runId: "evt_2:proc:mech-input-after", queued: true });

    await runInProcess(stub, (process) => {
      expect(process.runs.active).toMatchObject({ runId: "evt_1:proc:mech-input-after" });
      expect(process.store.queue.queueSize()).toBe(1);
    });
  });

  it("answers a redelivery with its first admission", async () => {
    const stub = await initProcess("mech-input-redelivery", ROOT_IDENTITY);
    const delivery = input("evt_1:personal:0", { message: "Once.", origin: CLIENT, runId: "run:msg-1" }, "interrupt");
    await stub.deliverEvent(delivery);

    await expect(stub.deliverEvent(delivery)).resolves.toEqual({ eventId: "evt_1:personal:0", runId: "run:msg-1", queued: false });
    await runInProcess(stub, (process) => {
      expect(process.store.messages.getMessages().filter((message) => message.role === "user")).toHaveLength(1);
    });
  });

  it("refuses a message whose media it can't read, without admitting it", async () => {
    const stub = await initProcess("mech-input-refused", ROOT_IDENTITY);
    const media = [{
      type: "resource",
      ref: { type: "file", target: "gsv", path: "/root/missing.png", revision: "missing", contentType: "image/png", size: 3 },
    } as const];

    const result = await stub.deliverEvent(input("evt_1:proc:mech-input-refused", { message: "Look.", origin: CLIENT, media }, "interrupt"));
    expect(result).toMatchObject({ eventId: "evt_1:proc:mech-input-refused", runId: null, queued: false, refused: expect.any(String) });
    await runInProcess(stub, (process) => {
      expect(process.runs.active).toBeNull();
      expect(process.store.messages.getMessages()).toEqual([]);
    });
  });

  it("takes messages only from the log", async () => {
    const stub = await initProcess("mech-input-frames", ROOT_IDENTITY);
    await expect(stub.recvFrame(makeReq("proc.send", { message: "Hello." }))).resolves.toMatchObject({
      type: "res", ok: false, error: { code: 400, message: "Unknown process command: proc.send" },
    });
    await runInProcess(stub, async (process) => {
      await expect(process.deliverEvent({
        eventId: "evt_1:proc:mech-input-frames", input: { message: "Hello." }, admission: { idle: "start", busy: "join" },
      })).rejects.toThrow("Process event is not registered for this delivery path");
    });
  });
});
