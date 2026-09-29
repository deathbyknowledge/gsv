import { randomId } from "../ids";
import type { StagedResourceUpload } from "../gateway/stagedResources";

export type ContactDraftSendIntent<T extends StagedResourceUpload & { id: string }> = {
  contactId: string;
  idempotencyKey: string;
  text: string;
  media: readonly T[];
};

export function selectContactSendIntent<T extends StagedResourceUpload & { id: string }>(
  previous: ContactDraftSendIntent<T> | null,
  contactId: string,
  text: string,
  media: readonly T[],
): ContactDraftSendIntent<T> {
  if (previous?.contactId === contactId && previous.text === text && previous.media.length === media.length
    && previous.media.every((file, index) => file.id === media[index]?.id)) return previous;
  return { contactId, idempotencyKey: randomId(), text, media };
}
