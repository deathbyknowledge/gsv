import type {
  FederationDeliveryReceipt,
} from "@humansandmachines/gsv/protocol";
import {
  FEDERATION_INBOX_RECOVERY_RETRY_MS,
  processFederationDelivery,
  recoverFederationInbox,
} from "./federation";
import {
  MANAGED_LIFECYCLE_RECHECK_MS,
} from "../installation/lifecycle";
import type { Kernel } from "./do";


export class FederationRuntime {
  constructor(readonly host: Kernel) {}

readonly pendingFederationInbound = new Map<
    string,
    Promise<FederationDeliveryReceipt>
  >();

readonly pendingFederationContacts = new Map<string, Promise<void>>();

async scheduleFederationDelivery(
    deliveryId: string,
    dueAtMs: number,
    idempotent = false,
  ): Promise<void> {
    await this.host.schedule(
      new Date(Math.max(Date.now() + 10, dueAtMs)),
      "onFederationDelivery",
      deliveryId,
      { idempotent },
    );
  }

async scheduleFederationInbox(
    contactId: string,
    contactGeneration: string,
    deliveryId: string,
    dueAtMs: number,
    idempotent = false,
  ): Promise<void> {
    await this.host.schedule(
      new Date(Math.max(Date.now() + 10, dueAtMs)),
      "onFederationInbox",
      { contactId, contactGeneration, deliveryId },
      { idempotent },
    );
  }

async coordinateFederationInbound(
    key: string,
    operation: () => Promise<FederationDeliveryReceipt>,
  ): Promise<FederationDeliveryReceipt> {
    const pending = this.pendingFederationInbound.get(key);
    if (pending) return await pending;
    const started = operation();
    this.pendingFederationInbound.set(key, started);
    try {
      return await started;
    } finally {
      if (this.pendingFederationInbound.get(key) === started) {
        this.pendingFederationInbound.delete(key);
      }
    }
  }

async coordinateFederationContact<Value>(
    contactId: string,
    operation: () => Value | Promise<Value>,
  ): Promise<Value> {
    const preceding = this.pendingFederationContacts.get(contactId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = preceding.catch(() => {}).then(() => current);
    this.pendingFederationContacts.set(contactId, tail);
    await preceding.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.pendingFederationContacts.get(contactId) === tail) {
        this.pendingFederationContacts.delete(contactId);
      }
    }
  }

async onFederationDelivery(deliveryId: string): Promise<void> {
    const gate = await this.host.onboarding.managedWorkGate();
    if (!gate.allowed) {
      await this.scheduleFederationDelivery(
        deliveryId,
        Date.now() + MANAGED_LIFECYCLE_RECHECK_MS,
      );
      return;
    }
    await processFederationDelivery(deliveryId, this.host.buildKernelContext({}));
  }

async onFederationInbox(
    payload: { contactId: string; contactGeneration: string; deliveryId: string },
  ): Promise<void> {
    const gate = await this.host.onboarding.managedWorkGate();
    if (!gate.allowed) {
      await this.scheduleFederationInbox(
        payload.contactId,
        payload.contactGeneration,
        payload.deliveryId,
        Date.now() + MANAGED_LIFECYCLE_RECHECK_MS,
      );
      return;
    }
    try {
      await recoverFederationInbox(
        payload.contactId,
        payload.contactGeneration,
        payload.deliveryId,
        this.host.buildKernelContext({}),
      );
    } catch (error) {
      const inbox = this.host.federation.inbox(
        payload.contactId,
        payload.contactGeneration,
        payload.deliveryId,
      );
      if (inbox?.state !== "received") return;
      console.warn(
        `[Kernel] Federation inbox ${payload.deliveryId} recovery failed:`,
        error instanceof Error ? error.message : String(error),
      );
      await this.scheduleFederationInbox(
        payload.contactId,
        payload.contactGeneration,
        payload.deliveryId,
        Date.now() + FEDERATION_INBOX_RECOVERY_RETRY_MS,
      );
    }
  }
}
