import { DEPLOYMENT_PRESENTATION_ELEMENT, deploymentPresentation, type PublicDeploymentConfig } from "@humansandmachines/gsv/services/deployment";

let sessionPresentation: (() => PublicDeploymentConfig | undefined) | undefined;

export function bindSessionPresentation(source: () => PublicDeploymentConfig | undefined): () => void {
  sessionPresentation = source;
  return () => { if (sessionPresentation === source) sessionPresentation = undefined; };
}

/** Web deployments inject this at the edge; native distributions supply build defaults. */
export function publicDeployment(): PublicDeploymentConfig {
  const connected = sessionPresentation?.();
  if (connected) return connected;
  const embedded = globalThis.document?.getElementById(DEPLOYMENT_PRESENTATION_ELEMENT)?.textContent;
  return deploymentPresentation(embedded || import.meta.env.VITE_GSV_PUBLIC_CONFIG || undefined);
}
