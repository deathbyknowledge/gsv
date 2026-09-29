import {
  createAiBindingFetch,
  type AiBinding,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import * as z from "zod/mini";
import type { InferenceAttribution } from "./text/provider";
import { inferenceRequestDiagnostics } from "./request-diagnostics";

const jsonBodySchema = z.string();

interface AiGatewayRequestMetadata {
  "gsv.installation_id": string;
  "gsv.request_id": string;
  "gsv.attempt_id": string;
  "gsv.request_bytes"?: number;
  "gsv.request_shape"?: string;
}

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
    const metadata: AiGatewayRequestMetadata = {
      "gsv.installation_id": installationId,
      "gsv.request_id": logicalRequestId,
      "gsv.attempt_id": crypto.randomUUID(),
    };
    const body = jsonBodySchema.safeParse(init?.body);
    if (body.success) {
      metadata["gsv.request_bytes"] = new Blob([body.data]).size;
      metadata["gsv.request_shape"] = inferenceRequestDiagnostics(body.data);
    }
    headers.set("cf-aig-metadata", JSON.stringify(metadata));
    return bindingFetch(input, { ...init, headers });
  };
}
