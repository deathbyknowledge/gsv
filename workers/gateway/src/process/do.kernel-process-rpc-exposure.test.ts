import { Kernel } from "../kernel/do";
import type { ResponseFrame, ResponseOkFrame } from "../protocol/frames";
import { getKernelPtr } from "../shared/utils";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeReq, registerInKernel } from "./do-test-harness";

describe("kernel process RPC exposure", () => {
  it("allows non-root processes to call internal ai.config", async () => {
    const pid = "mech-kernel-ai-config";
    const identity: ProcessIdentity = {
      uid: 1000,
      gid: 1000,
      gids: [1000, 100],
      username: "sam",
      home: "/home/sam",
      cwd: "/home/sam",
    };

    await registerInKernel(pid, identity);
    const kernel = await getKernelPtr();

    const response = await runInDurableObject(kernel, (instance: Kernel) =>
      instance.recvFrame(pid, makeReq("ai.config", {})),
    );

    expect(response).not.toBeNull();
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((response as ResponseFrame).ok).toBe(true);
  });

  it("includes CodeMode in ai.tools for default user capabilities", async () => {
    const pid = "mech-kernel-ai-tools-codemode";
    const identity: ProcessIdentity = {
      uid: 1000,
      gid: 1000,
      gids: [1000, 100],
      username: "sam",
      home: "/home/sam",
      cwd: "/home/sam",
    };

    await registerInKernel(pid, identity);
    const kernel = await getKernelPtr();

    // SAFETY: test fixture is constructed with the asserted domain shape.

    const response = (await runInDurableObject(
      kernel,
      (instance: Kernel) => instance.recvFrame(pid, makeReq("ai.tools", {})),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    )) as ResponseOkFrame;

    expect(response.ok).toBe(true);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = response.data as {
      tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
    };
    const codeMode = data.tools.find((tool) => tool.name === "CodeMode");
    expect(codeMode).toBeDefined();
    expect(codeMode?.inputSchema.required).toEqual(["code"]);
    expect(data.tools.find((tool) => tool.name === "ProcessMessage")).toBeUndefined();
  });
});
