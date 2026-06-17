import type {
  OnboardingDetailStep,
  OnboardingDraft,
  OnboardingLane,
} from "@humansandmachines/gsv/protocol";
import type { SessionSnapshot, SessionSetupInput } from "../../services/session/sessionService";

export type PendingAction = "login" | "setup" | "continue" | null;
export type AdminMode = "same" | "custom";
export type SessionView = "booting" | "login" | "setup" | "provisioning" | "complete" | "desktop";
export type InstallPlatform = "macos" | "linux" | "windows";

export type SetupLaneMeta = {
  label: string;
  kicker: string;
  title: string;
  description: string;
  reviewCopy: string;
  estimate: string;
};

export type ValidationResult = {
  message: string | null;
  step?: OnboardingDetailStep;
};

export type SetupResultViewModel = {
  username: string;
  rootLabel: string;
  sourceLabel: string;
  refLabel: string;
  cliLabel: string;
  cliCommand: string;
  cliMeta: string;
  node: {
    visible: boolean;
    label: string;
    command: string;
    meta: string;
  };
};

export const DEFAULT_SOURCE_LABEL = "Official system files";
export const DEFAULT_SOURCE_REF = "Default version";

export const SETUP_LANE_META: Record<OnboardingLane, SetupLaneMeta> = {
  quick: {
    label: "Quick start",
    kicker: "Quick start",
    title: "Create the first operator",
    description: "Use the official system files and the default AI path. You only need the account and admin credentials.",
    reviewCopy: "Fastest path with the official system files and default AI configuration.",
    estimate: "expected time to completion: 1 min",
  },
  customize: {
    label: "Custom",
    kicker: "Custom",
    title: "Tune the parts that matter",
    description: "Adjust AI defaults, system files, and optional device setup without dealing with every low-level detail.",
    reviewCopy: "Custom setup with optional AI, system files, and device customization.",
    estimate: "expected time to completion: 3 min",
  },
  advanced: {
    label: "Custom",
    kicker: "Custom",
    title: "Take full control from first boot",
    description: "Choose the exact system files and version up front, configure AI explicitly, and create a device setup key if needed.",
    reviewCopy: "Full-control setup with explicit system files and detailed choices.",
    estimate: "expected time to completion: 3 min",
  },
};

export function isValidUsername(value: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(value);
}

export function isPositiveNumber(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function timeZoneOptions(): string[] {
  const supported = (Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  }).supportedValuesOf?.("timeZone") ?? [];
  const preferred = [
    browserTimeZone(),
    "UTC",
    "Europe/Amsterdam",
    "Europe/London",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Asia/Tokyo",
    "Australia/Sydney",
  ];
  return [...new Set([...preferred, ...supported])]
    .filter((zone) => zone && isValidTimeZone(zone))
    .sort((left, right) => left.localeCompare(right));
}

export function sourceLooksLikeRemote(value: string): boolean {
  return value.includes("://") || value.startsWith("git@");
}

export function detectBrowserInstallPlatform(): InstallPlatform {
  if (typeof navigator === "undefined") {
    return "linux";
  }
  const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (platform.includes("win")) {
    return "windows";
  }
  if (platform.includes("mac") || platform.includes("darwin")) {
    return "macos";
  }
  return "linux";
}

export function installPlatformLabel(platform: InstallPlatform): string {
  switch (platform) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    default:
      return "Linux";
  }
}

export function gatewayOrigin(): string {
  return typeof window === "undefined" ? "http://localhost:8787" : window.location.origin;
}

export function gatewayWsUrl(origin: string): string {
  if (origin.startsWith("https://")) {
    return `wss://${origin.slice("https://".length)}/ws`;
  }
  if (origin.startsWith("http://")) {
    return `ws://${origin.slice("http://".length)}/ws`;
  }
  return `${origin.replace(/\/+$/g, "")}/ws`;
}

export function cliInstallCommand(origin: string, platform: InstallPlatform): string {
  return platform === "windows"
    ? `$env:GSV_BASE_URL='${origin}'; irm ${origin}/public/gsv/downloads/cli/install.ps1 | iex`
    : `curl -fsSL ${origin}/public/gsv/downloads/cli/install.sh | bash -s -- ${origin}`;
}

export function defaultWorkspacePath(platform: InstallPlatform): string {
  return platform === "windows" ? "\"$HOME\"" : "~/";
}

export function buildNodeBootstrapCommand(
  origin: string,
  platform: InstallPlatform,
  deviceId: string,
  token: string,
): string {
  const escapedDeviceId = deviceId.replaceAll("\"", "\\\"");
  const escapedToken = token.replaceAll("\"", "\\\"");
  const escapedGatewayUrl = gatewayWsUrl(origin).replaceAll("\"", "\\\"");
  return [
    cliInstallCommand(origin, platform),
    `gsv config --local set gateway.url "${escapedGatewayUrl}"`,
    `gsv config --local set node.id "${escapedDeviceId}"`,
    `gsv config --local set node.token "${escapedToken}"`,
    `gsv device install --id "${escapedDeviceId}" --workspace ${defaultWorkspacePath(platform)}`,
  ].join("\n");
}

export function detailStepsForLane(lane: OnboardingLane): OnboardingDetailStep[] {
  void lane;
  return ["account", "system"];
}

export function currentDetailStep(draft: OnboardingDraft): OnboardingDetailStep {
  const steps = detailStepsForLane(draft.lane);
  const current = draft.detailStep;
  if ((current === "admin" || current === "ai" || current === "source" || current === "device") && steps.includes("system")) {
    return "system";
  }
  return steps.includes(current) ? current : steps[0] ?? "account";
}

export function advancedSectionsVisible(draft: OnboardingDraft): boolean {
  return draft.lane === "customize" || draft.lane === "advanced";
}

export function guideShortcutReady(draft: OnboardingDraft, reviewReady: boolean): boolean {
  return draft.mode === "guided" && reviewReady;
}

export function validateSetupDetails(
  draft: OnboardingDraft,
  validateAll = false,
): ValidationResult {
  const steps = validateAll ? detailStepsForLane(draft.lane) : [currentDetailStep(draft)];

  for (const step of steps) {
    if (step === "account") {
      const username = draft.account.username.trim();
      const agentName = draft.account.agentName.trim();
      if (!username) {
        return { message: "Username is required.", step };
      }
      if (!isValidUsername(username)) {
        return { message: "Username must match ^[a-z_][a-z0-9_-]{0,31}$.", step };
      }
      if (agentName && !isValidUsername(agentName)) {
        return { message: "Personal agent username must match ^[a-z_][a-z0-9_-]{0,31}$.", step };
      }
      if (agentName && agentName === username) {
        return { message: "Personal agent username must be different from the desktop username.", step };
      }
      if (draft.account.password.length < 8) {
        return { message: "Password must be at least 8 characters.", step };
      }
      if (draft.account.password !== draft.account.passwordConfirm) {
        return { message: "Passwords do not match.", step };
      }
    }

    if (step === "system") {
      if (!draft.system.timezone.trim()) {
        return { message: "Timezone is required.", step };
      }
      if (!isValidTimeZone(draft.system.timezone.trim())) {
        return { message: "Timezone must be a valid IANA timezone.", step };
      }
      if (draft.admin.mode === "custom") {
        if (draft.admin.password.length < 8) {
          return { message: "Admin password must be at least 8 characters.", step };
        }
        if (draft.admin.password !== draft.admin.passwordConfirm) {
          return { message: "Admin passwords do not match.", step };
        }
      }
      if (advancedSectionsVisible(draft) && draft.ai.enabled) {
        if (!draft.ai.provider.trim()) {
          return { message: "AI service is required when customizing AI settings.", step };
        }
        if (!draft.ai.model.trim()) {
          return { message: "AI model is required when customizing AI settings.", step };
        }
      }
      if (advancedSectionsVisible(draft) && draft.source.enabled && !draft.source.value.trim()) {
        return { message: "System files location is required when using custom system files.", step };
      }
      if (advancedSectionsVisible(draft) && draft.device.enabled) {
        if (!draft.device.deviceId.trim()) {
          return { message: "Device ID is required when creating a device setup key.", step };
        }
        const expiry = draft.device.expiryDays.trim();
        if (expiry && !isPositiveNumber(expiry)) {
          return { message: "Expiry must be a positive number of days.", step };
        }
      }
    }
  }

  return { message: null };
}

export function buildSourceSummary(draft: OnboardingDraft): string {
  if (!advancedSectionsVisible(draft) || !draft.source.enabled) {
    return DEFAULT_SOURCE_LABEL;
  }
  const source = draft.source.value.trim();
  const ref = draft.source.ref.trim();
  if (!source) {
    return DEFAULT_SOURCE_LABEL;
  }
  return ref ? `${source}#${ref}` : source;
}

export function buildAiSummary(draft: OnboardingDraft): string {
  if (!advancedSectionsVisible(draft) || !draft.ai.enabled) {
    return "Use default AI";
  }
  const provider = draft.ai.provider.trim();
  const model = draft.ai.model.trim();
  return provider && model ? `${provider} / ${model}` : "Custom AI settings";
}

export function buildDeviceSummary(draft: OnboardingDraft): string {
  if (!advancedSectionsVisible(draft) || !draft.device.enabled) {
    return "Do not create a device setup key";
  }
  const deviceId = draft.device.deviceId.trim();
  return deviceId ? `Create setup key for ${deviceId}` : "Create device setup key";
}

export function buildSetupPayload(draft: OnboardingDraft): SessionSetupInput {
  const agentName = draft.account.agentName.trim();
  const payload: SessionSetupInput = {
    username: draft.account.username.trim(),
    password: draft.account.password,
    timezone: draft.system.timezone.trim(),
  };

  if (agentName) {
    payload.agentName = agentName;
  }

  if (draft.admin.mode === "custom" && draft.admin.password) {
    payload.rootPassword = draft.admin.password;
  }

  if (advancedSectionsVisible(draft) && draft.ai.enabled) {
    payload.ai = {
      provider: draft.ai.provider.trim(),
      model: draft.ai.model.trim(),
      ...(draft.ai.apiKey.trim() ? { apiKey: draft.ai.apiKey.trim() } : {}),
    };
  }

  if (advancedSectionsVisible(draft) && draft.source.enabled) {
    const source = draft.source.value.trim();
    const ref = draft.source.ref.trim();
    payload.bootstrap = sourceLooksLikeRemote(source)
      ? { remoteUrl: source }
      : { repo: source };
    if (ref) {
      payload.bootstrap.ref = ref;
    }
  }

  if (advancedSectionsVisible(draft) && draft.device.enabled) {
    const expiryDays = draft.device.expiryDays.trim();
    payload.node = {
      deviceId: draft.device.deviceId.trim(),
      ...(draft.device.label.trim() ? { label: draft.device.label.trim() } : {}),
      ...(expiryDays
        ? { expiresAt: Date.now() + Math.floor(Number(expiryDays) * 24 * 60 * 60 * 1000) }
        : {}),
    };
  }

  return payload;
}

export function resolveVisibleView(
  snapshot: SessionSnapshot,
  pendingAction: PendingAction,
): SessionView {
  if (snapshot.phase === "ready") {
    return "desktop";
  }
  if (snapshot.phase === "booting") {
    return "booting";
  }
  if (pendingAction === "setup" && snapshot.phase !== "setup-complete") {
    return "provisioning";
  }
  if (pendingAction === "continue") {
    return "provisioning";
  }
  if (snapshot.phase === "setup-complete") {
    return "complete";
  }
  if (snapshot.phase === "setup") {
    return "setup";
  }
  return "login";
}

export function provisioningCopy(pendingAction: PendingAction): { title: string; copy: string } {
  if (pendingAction === "continue") {
    return {
      title: "Opening desktop",
      copy: "Loading your desktop.",
    };
  }
  return {
    title: "Setting up your workspace",
    copy: pendingAction === "setup"
      ? "Creating your account, preparing system files, and opening the desktop."
      : "Preparing the first session.",
  };
}

export function setupResultViewModel(
  snapshot: SessionSnapshot,
  adminMode: AdminMode,
): SetupResultViewModel {
  const result = snapshot.setupResult;
  const origin = gatewayOrigin();
  const platform = detectBrowserInstallPlatform();
  const defaultChannel = result?.bootstrap?.cli.defaultChannel ?? "stable";
  const rootLabel = adminMode === "custom" ? "Extra admin security layer" : "Account password";
  const cliCommand = cliInstallCommand(origin, platform);
  const cliMeta = platform === "windows"
    ? `Uses the ${defaultChannel} release channel. The PowerShell installer will report clearly if Windows tools are not available yet.`
    : `Uses the ${defaultChannel} release channel and picks the right tools for this machine.`;

  if (!result) {
    return {
      username: snapshot.username || "Unknown",
      rootLabel,
      sourceLabel: DEFAULT_SOURCE_LABEL,
      refLabel: DEFAULT_SOURCE_REF,
      cliLabel: `Tools for ${installPlatformLabel(platform)}`,
      cliCommand,
      cliMeta,
      node: {
        visible: false,
        label: "Connect a device",
        command: "",
        meta: "",
      },
    };
  }

  if (!result.nodeToken) {
    return {
      username: result.user.username,
      rootLabel,
      sourceLabel: result.bootstrap?.remoteUrl ?? DEFAULT_SOURCE_LABEL,
      refLabel: result.bootstrap?.ref ?? DEFAULT_SOURCE_REF,
      cliLabel: `Tools for ${installPlatformLabel(platform)}`,
      cliCommand,
      cliMeta,
      node: {
        visible: false,
        label: "Connect a device",
        command: "",
        meta: "",
      },
    };
  }

  const deviceId = result.nodeToken.allowedDeviceId ?? "node-id";
  const expiresLabel = typeof result.nodeToken.expiresAt === "number"
    ? `Expires ${new Date(result.nodeToken.expiresAt).toLocaleString()}`
    : "No expiry";

  return {
    username: result.user.username,
    rootLabel,
    sourceLabel: result.bootstrap?.remoteUrl ?? DEFAULT_SOURCE_LABEL,
    refLabel: result.bootstrap?.ref ?? DEFAULT_SOURCE_REF,
    cliLabel: `Tools for ${installPlatformLabel(platform)}`,
    cliCommand,
    cliMeta,
    node: {
      visible: true,
      label: result.nodeToken.label ?? deviceId,
      command: buildNodeBootstrapCommand(origin, platform, deviceId, result.nodeToken.token),
      meta: `${deviceId} \u00b7 ${expiresLabel} \u00b7 ${installPlatformLabel(platform)} setup steps shown`,
    },
  };
}
