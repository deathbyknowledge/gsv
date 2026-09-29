import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import {
  installationDeletionInspectionSchema,
  type InstallationDeletionInspection,
  type InstallationDeletionInspectionResult,
  type InstallationResourceObservation,
} from "@humansandmachines/gsv/services/lifecycle-discovery";

type NamedInferenceNamespace = {
  kind: "inference-executor" | "inference-installation";
  namespace: Pick<DurableObjectNamespace, "idFromName">;
};
type DiscoveryAuthority = { authority?: string };

/** Match physical addresses without opening or initializing historical objects. */
export async function inspectInferenceDeletion(
  directory: InstallationDirectoryService,
  props: DiscoveryAuthority,
  namespaces: readonly NamedInferenceNamespace[],
  value: InstallationDeletionInspection,
): Promise<InstallationDeletionInspectionResult> {
  if (props.authority !== "installation-deletion") throw new Error("Inference deletion authority is required");
  const input = installationDeletionInspectionSchema.parse(value);
  const target = await directory.resolveInstallation(input.installationId);
  if (!target.found || target.installationId !== input.installationId) throw new Error("Inference discovery requires a known installation");
  const candidates = new Set([input.installationId, ...(input.candidateInstallationIds ?? [])]);
  const resolved = new Map([[input.installationId, true]]);
  const observations: InstallationResourceObservation[] = [];
  for (const resource of input.resources) {
    const owner = namespaces.find((namespace) => namespace.kind === resource.kind);
    if (!owner) throw new Error("Resource kind is not owned by inference");
    const name = [...candidates].find((candidate) => owner.namespace.idFromName(candidate).toString() === resource.objectId);
    if (!name || (resource.name !== undefined && resource.name !== name)) {
      observations.push({ ...resource, outcome: "unidentified" });
      continue;
    }
    if (!resolved.has(name)) {
      const identity = await directory.resolveInstallation(name);
      resolved.set(name, identity.found && identity.installationId === name);
    }
    observations.push(resolved.get(name)
      ? { ...resource, name, installationId: name, outcome: "identified" }
      : { ...resource, outcome: "unidentified" });
  }
  return { installationId: input.installationId, observations };
}
