import type {
  FederationResourceDescriptor,
  ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import {
  federationResourceDescriptorSchema,
  MAX_FEDERATION_MESSAGE_RESOURCES,
  MAX_FEDERATION_MESSAGE_RESOURCE_BYTES,
  MAX_FEDERATION_RESOURCE_BYTES,
  resourceBlockSchema,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type { FederationContactRecord } from "../federation-store";
import { PublicFederationError } from "./errors";

const MAX_ACTIVE_RESOURCE_GRANTS_PER_CONTACT = 20_000;
const MAX_ACTIVE_RESOURCE_GRANTS_PER_INSTALLATION = 100_000;

export function createResourceGrant(
  contact: FederationContactRecord,
  ownerUid: number,
  resourceValue: ResourceBlock,
  ctx: KernelContext,
  now: number,
): FederationResourceDescriptor {
  const resource = resourceBlockSchema.parse(resourceValue);
  if (resource.ref.target !== "gsv" || resource.ref.expiresAt !== undefined) {
    throw new Error("Contact resources must be retained as immutable GSV references");
  }
  if (resource.ref.size > MAX_FEDERATION_RESOURCE_BYTES) {
    throw new Error(`Contact resource exceeds ${MAX_FEDERATION_RESOURCE_BYTES} bytes`);
  }
  return ctx.federation.createGrant({
    contactId: contact.id,
    contactGeneration: contact.generation,
    source: resource,
    sourceUid: ownerUid,
    descriptor: {
      revision: resource.ref.revision,
      contentType: resource.ref.contentType,
      size: resource.ref.size,
      ...(resource.mediaType ? { mediaType: resource.mediaType } : undefined),
      ...(resource.filename ? { filename: resource.filename } : undefined),
      ...(resource.duration !== undefined ? { duration: resource.duration } : undefined),
      ...(resource.transcription ? { transcription: resource.transcription } : undefined),
    },
    now,
  });
}

export function localizeResource(
  contact: FederationContactRecord,
  descriptorValue: FederationResourceDescriptor,
): ResourceBlock {
  const descriptor = federationResourceDescriptorSchema.parse(descriptorValue);
  return resourceBlockSchema.parse({
    type: "resource",
    ref: {
      type: "file",
      target: contact.id,
      path: `/resources/${encodeURIComponent(descriptor.id)}`,
      revision: descriptor.revision,
      contentType: descriptor.contentType,
      size: descriptor.size,
    },
    ...(descriptor.mediaType ? { mediaType: descriptor.mediaType } : undefined),
    ...(descriptor.filename ? { filename: descriptor.filename } : undefined),
    ...(descriptor.duration !== undefined ? { duration: descriptor.duration } : undefined),
    ...(descriptor.transcription ? { transcription: descriptor.transcription } : undefined),
  });
}

export function assertResourceGrantCapacity(
  contactId: string,
  added: number,
  ctx: KernelContext,
): void {
  if (added === 0) return;
  if (
    ctx.federation.activeGrantCount(contactId) + added > MAX_ACTIVE_RESOURCE_GRANTS_PER_CONTACT
    || ctx.federation.activeGrantCount() + added > MAX_ACTIVE_RESOURCE_GRANTS_PER_INSTALLATION
  ) {
    throw new Error("Contact resource grant limit reached");
  }
}

export function validateFederationResources(
  resources: ResourceBlock[] | undefined,
): ResourceBlock[] | undefined {
  if (!resources?.length) return undefined;
  if (resources.length > MAX_FEDERATION_MESSAGE_RESOURCES) {
    throw new Error(`Contact messages accept at most ${MAX_FEDERATION_MESSAGE_RESOURCES} resources`);
  }
  let total = 0;
  return resources.map((value) => {
    const resource = resourceBlockSchema.parse(value);
    if (resource.ref.size > MAX_FEDERATION_RESOURCE_BYTES) {
      throw new Error(`Contact resource exceeds ${MAX_FEDERATION_RESOURCE_BYTES} bytes`);
    }
    total += resource.ref.size;
    if (total > MAX_FEDERATION_MESSAGE_RESOURCE_BYTES) {
      throw new Error(
        `Contact message resources exceed ${MAX_FEDERATION_MESSAGE_RESOURCE_BYTES} bytes`,
      );
    }
    return resource;
  });
}

export function validateFederationResourceDescriptors(
  resources: FederationResourceDescriptor[] | undefined,
): FederationResourceDescriptor[] | undefined {
  if (!resources?.length) return undefined;
  let total = 0;
  return resources.map((value) => {
    const resource = federationResourceDescriptorSchema.parse(value);
    total += resource.size;
    if (total > MAX_FEDERATION_MESSAGE_RESOURCE_BYTES) {
      throw new PublicFederationError(413, "Federation message resources are too large");
    }
    return resource;
  });
}

export function federationContactStream(
  stream: ReadableStream<Uint8Array>,
  isCurrent: () => boolean,
  onFinish?: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    reader.releaseLock();
    try {
      onFinish?.();
    } catch (error) {
      console.warn(
        "[Kernel] Failed to release federation resource read:",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const cancelSuperseded = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> => {
    const error = new Error("Federation resource authorization changed");
    await reader.cancel(error).catch(() => {});
    finish();
    controller.error(error);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!isCurrent()) {
          await cancelSuperseded(controller);
          return;
        }
        const chunk = await reader.read();
        if (!isCurrent()) {
          await cancelSuperseded(controller);
          return;
        }
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      finish();
    },
  });
}

export function isCurrentFederationContact(
  contactId: string,
  contactGeneration: string,
  ctx: KernelContext,
): boolean {
  const contact = ctx.federation.get(contactId);
  return contact !== null
    && contact.state === "active"
    && contact.generation === contactGeneration;
}

export function isCurrentFederationResource(
  contactId: string,
  contactGeneration: string,
  resourceId: string,
  ctx: KernelContext,
): boolean {
  if (!isCurrentFederationContact(contactId, contactGeneration, ctx)) return false;
  const grant = ctx.federation.grant(resourceId);
  return grant !== null
    && grant.contactId === contactId
    && grant.contactGeneration === contactGeneration;
}
