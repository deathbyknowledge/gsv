import type {
  InstallationDirectoryService,
  InstallationOnboardingService,
} from "@humansandmachines/gsv/protocol";
import {
  LEGACY_STANDALONE_INSTALLATION_ID,
  parseCanonicalOrigin,
  parseInstallationHandle,
  parseInstallationId,
  type InstallationId,
} from "./identity";

type GatewayDeploymentBindings = {
  INSTALLATION_DIRECTORY?: InstallationDirectoryService & InstallationOnboardingService;
  GSV_INSTALLATION_ID?: string;
  GSV_INSTALLATION_HANDLE?: string;
  GSV_CANONICAL_ORIGIN?: string;
};

export type GatewayDeployment =
  | {
      kind: "managed";
      directory: InstallationDirectoryService & InstallationOnboardingService;
    }
  | {
      kind: "standalone";
      installationId: InstallationId;
      handle: string;
      canonicalOrigin?: string;
    };

export function getGatewayDeployment(env: Env): GatewayDeployment {
  const bindings = gatewayDeploymentBindings(env);
  if (bindings.INSTALLATION_DIRECTORY !== undefined) {
    return {
      kind: "managed",
      directory: bindings.INSTALLATION_DIRECTORY,
    };
  }

  return {
    kind: "standalone",
    installationId: parseInstallationId(
      bindings.GSV_INSTALLATION_ID ?? LEGACY_STANDALONE_INSTALLATION_ID,
    ),
    handle: parseInstallationHandle(bindings.GSV_INSTALLATION_HANDLE ?? "gsv"),
    ...(bindings.GSV_CANONICAL_ORIGIN !== undefined
      ? { canonicalOrigin: parseCanonicalOrigin(bindings.GSV_CANONICAL_ORIGIN) }
      : {}),
  };
}

export function isManagedGatewayDeployment(env: Env | undefined): boolean {
  return env !== undefined
    && gatewayDeploymentBindings(env).INSTALLATION_DIRECTORY !== undefined;
}

function gatewayDeploymentBindings(env: Env): GatewayDeploymentBindings {
  return env as Env & GatewayDeploymentBindings;
}
