import { vi } from "vitest";
import type { Mock } from "vitest";
import * as processTransport from "../shared/utils";

type Deliver = typeof processTransport.deliverEventToProcess;

const acknowledge: Deliver = async (_installationId, _pid, args) => ({ eventId: args.eventId, runId: null, queued: false });

/**
 * Spies on the Process deliveries of the installations a test owns. Every Kernel in a unit test
 * isolate delivers through one module function, Kernels that earlier tests left with work due
 * included, so the returned mock answers and counts only the owned installations' deliveries, and
 * its one-shot answers go only to them. Every other delivery is acknowledged without being recorded.
 */
export function spyOnProcessDeliveries(owns: (installationId: string) => boolean, answer: Deliver = acknowledge): Mock<Deliver> {
  const deliver = vi.fn(answer);
  vi.spyOn(processTransport, "deliverEventToProcess").mockImplementation((installationId, pid, args) => (
    owns(installationId) ? deliver(installationId, pid, args) : acknowledge(installationId, pid, args)
  ));
  return deliver;
}
