import {
  createAiBindingFetch,
  type AiBinding,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import type { InferenceAttribution } from "./text/provider";
import { inferenceRequestShape } from "./request-shape";

/** Attribution comes from the executing installation owner, never request headers. */
export function createAttributedAiBindingFetch(
  binding: AiBinding,
  attribution: Pick<InferenceAttribution, "installationId" | "logicalRequestId"> | undefined,
): typeof fetch {
  const bindingFetch = createAiBindingFetch(binding);
  if (!attribution) throw new Error("Workers AI requires installation request attribution");
  const { installationId, logicalRequestId } = attribution;
  return (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    // Apply after provider/header merging, including retries and fallback dispatches.
    headers.set("cf-aig-metadata", JSON.stringify({
      "gsv.installation_id": installationId,
      "gsv.request_id": logicalRequestId,
      "gsv.attempt_id": crypto.randomUUID(),
      ...(typeof init?.body === "string" ? {
        "gsv.request_bytes": new Blob([init.body]).size,
        "gsv.request_shape": inferenceRequestShape(init.body),
      } : {}),
    }));
    return bindingFetch(input, { ...init, headers });
  };
}
