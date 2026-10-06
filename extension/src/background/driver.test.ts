import type { GsvEndpointContext, GsvEndpointRequest } from "@humansandmachines/gsv/client";
import { describe, expect, it } from "vitest";
import { createBrowserTargetDriver } from "./driver";

describe("browser target activity", () => {
  it("counts overlapping requests until they finish", async () => {
    const driver = createBrowserTargetDriver();
    const context = {
      abortSignal: new AbortController().signal,
      connection: { peer: { id: "chrome" } },
    } as GsvEndpointContext;
    const request = (id: string): GsvEndpointRequest => ({
      id,
      call: "shell.exec",
      args: { input: "help" },
    }) as unknown as GsvEndpointRequest;

    const first = driver.handle(request("first"), context);
    const second = driver.handle(request("second"), context);
    expect(driver.activeRequests()).toHaveLength(2);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
    ]);
    expect(driver.activeRequests()).toHaveLength(0);
  });

  it("clears the count when a request fails", async () => {
    const driver = createBrowserTargetDriver();
    const context = { abortSignal: new AbortController().signal } as GsvEndpointContext;
    const request = { id: "unsupported", call: "unsupported", args: {} } as unknown as GsvEndpointRequest;

    await expect(driver.handle(request, context)).rejects.toThrow("Unsupported browser target syscall");
    expect(driver.activeRequests()).toHaveLength(0);
  });
});
