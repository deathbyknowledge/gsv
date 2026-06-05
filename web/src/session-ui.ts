import type { SessionService, SessionSnapshot, SessionSetupInput } from "./session-service";
import { createOnboardingService } from "./onboarding-service";
import type {
  OnboardingDetailStep,
  OnboardingDraft,
  OnboardingLane,
  OnboardingStage,
} from "@gsv/protocol/syscalls/system";

type SessionUiOptions = {
  rootNode: HTMLElement;
  session: SessionService;
};

type SessionUiController = {
  destroy: () => void;
};

type PendingAction = "login" | "setup" | "continue" | null;
type AdminMode = "same" | "custom";

type SetupLaneMeta = {
  label: string;
  kicker: string;
  title: string;
  description: string;
  reviewCopy: string;
  estimate: string;
};

type ValidationResult = {
  message: string | null;
  step?: OnboardingDetailStep;
};

type InstallPlatform = "macos" | "linux" | "windows";

const DEFAULT_SOURCE_LABEL = "Official system files";
const DEFAULT_SOURCE_REF = "Default version";

const SETUP_LANE_META: Record<OnboardingLane, SetupLaneMeta> = {
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

function statusText(snapshot: SessionSnapshot): string {
  switch (snapshot.phase) {
    case "ready":
      return "session: connected";
    case "setup":
      return "session: setup required";
    case "setup-complete":
      return "session: setup complete";
    case "authenticating":
      return "session: setting up...";
    default:
      return "session: locked";
  }
}

function isValidUsername(value: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(value);
}

function isPositiveNumber(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function timeZoneOptions(): string[] {
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

function sourceLooksLikeRemote(value: string): boolean {
  return value.includes("://") || value.startsWith("git@");
}

function detectBrowserInstallPlatform(): InstallPlatform {
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

function installPlatformLabel(platform: InstallPlatform): string {
  switch (platform) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    default:
      return "Linux";
  }
}

function gatewayOrigin(): string {
  return typeof window === "undefined" ? "http://localhost:8787" : window.location.origin;
}

function gatewayWsUrl(origin: string): string {
  if (origin.startsWith("https://")) {
    return `wss://${origin.slice("https://".length)}/ws`;
  }
  if (origin.startsWith("http://")) {
    return `ws://${origin.slice("http://".length)}/ws`;
  }
  return `${origin.replace(/\/+$/g, "")}/ws`;
}

function cliInstallCommand(origin: string, platform: InstallPlatform): string {
  return platform === "windows"
    ? `$env:GSV_BASE_URL='${origin}'; irm ${origin}/public/gsv/downloads/cli/install.ps1 | iex`
    : `curl -fsSL ${origin}/public/gsv/downloads/cli/install.sh | bash -s -- ${origin}`;
}

function defaultWorkspacePath(platform: InstallPlatform): string {
  return platform === "windows" ? "\"$HOME\"" : "~/";
}

function buildNodeBootstrapCommand(
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

export function createSessionUi(options: SessionUiOptions): SessionUiController {
  const { rootNode, session } = options;

  const screenNode = rootNode.querySelector<HTMLElement>("[data-session-screen]");
  const desktopRootNode = rootNode.querySelector<HTMLElement>("[data-desktop-root]");
  const loginViewNode = rootNode.querySelector<HTMLElement>("[data-session-login-view]");
  const setupViewNode = rootNode.querySelector<HTMLElement>("[data-session-setup-view]");
  const provisioningViewNode = rootNode.querySelector<HTMLElement>("[data-session-provisioning-view]");
  const setupCompleteNode = rootNode.querySelector<HTMLElement>("[data-session-setup-complete]");
  const loginFormNode = rootNode.querySelector<HTMLFormElement>("[data-session-login-form]");
  const setupFormNode = rootNode.querySelector<HTMLFormElement>("[data-session-setup-form]");
  const usernameInputNode = rootNode.querySelector<HTMLInputElement>("[data-session-username]");
  const passwordInputNode = rootNode.querySelector<HTMLInputElement>("[data-session-password]");
  const tokenInputNode = rootNode.querySelector<HTMLInputElement>("[data-session-token]");
  const loginErrorNode = rootNode.querySelector<HTMLElement>("[data-session-login-error]");
  const setupErrorNode = rootNode.querySelector<HTMLElement>("[data-session-setup-error]");
  const submitNode = rootNode.querySelector<HTMLButtonElement>("[data-session-submit]");
  const statusNode = rootNode.querySelector<HTMLElement>("[data-session-status]");
  const dotNode = rootNode.querySelector<HTMLElement>("[data-session-dot]");
  const lockNode = rootNode.querySelector<HTMLButtonElement>("[data-session-lock]");
  const mobileHomeUsernameNode = rootNode.querySelector<HTMLElement>("[data-mobile-home-username]");
  const mobileHomeDateNode = rootNode.querySelector<HTMLElement>("[data-mobile-home-date]");
  const setupHeadingNode = rootNode.querySelector<HTMLElement>("[data-setup-heading]");
  const setupCopyNode = rootNode.querySelector<HTMLElement>("[data-setup-copy]");
  const setupStagePills = Array.from(rootNode.querySelectorAll<HTMLElement>("[data-setup-stage-pill]"));
  const setupDetailSections = Array.from(rootNode.querySelectorAll<HTMLElement>("[data-setup-detail-step]"));
  const setupWelcomeNode = rootNode.querySelector<HTMLElement>("[data-setup-stage='welcome']");
  const setupDetailsNode = rootNode.querySelector<HTMLElement>("[data-setup-stage='details']");
  const setupReviewNode = rootNode.querySelector<HTMLElement>("[data-setup-stage='review']");
  const setupLaneButtons = Array.from(rootNode.querySelectorAll<HTMLButtonElement>("[data-setup-lane]"));
  const setupLaneKickerNode = rootNode.querySelector<HTMLElement>("[data-setup-lane-kicker]");
  const setupDetailCopyNode = rootNode.querySelector<HTMLElement>("[data-setup-detail-copy]");
  const setupLaneTitleNode = rootNode.querySelector<HTMLElement>("[data-setup-lane-title]");
  const setupLaneDescriptionNode = rootNode.querySelector<HTMLElement>("[data-setup-lane-description]");
  const setupBackNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-back]");
  const setupNextNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-next]");
  const setupSubmitNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-submit]");
  const setupUsernameNode = rootNode.querySelector<HTMLInputElement>("[data-setup-username]");
  const setupAgentNameNode = rootNode.querySelector<HTMLInputElement>("[data-setup-agent-name]");
  const setupPasswordNode = rootNode.querySelector<HTMLInputElement>("[data-setup-password]");
  const setupPasswordConfirmNode = rootNode.querySelector<HTMLInputElement>("[data-setup-password-confirm]");
  const setupAdminCustomNode = rootNode.querySelector<HTMLInputElement>("[data-setup-admin-custom]");
  const setupRootRowNode = rootNode.querySelector<HTMLElement>("[data-setup-root-row]");
  const setupRootConfirmRowNode = rootNode.querySelector<HTMLElement>("[data-setup-root-confirm-row]");
  const setupRootPasswordNode = rootNode.querySelector<HTMLInputElement>("[data-setup-root-password]");
  const setupRootPasswordConfirmNode = rootNode.querySelector<HTMLInputElement>("[data-setup-root-password-confirm]");
  const setupTimeZoneNode = rootNode.querySelector<HTMLSelectElement>("[data-setup-timezone]");
  const setupAiSectionNode = rootNode.querySelector<HTMLElement>("[data-setup-ai-section]");
  const setupAiEnabledNode = rootNode.querySelector<HTMLInputElement>("[data-setup-ai-enabled]");
  const setupAiProviderRowNode = rootNode.querySelector<HTMLElement>("[data-setup-ai-provider-row]");
  const setupAiModelRowNode = rootNode.querySelector<HTMLElement>("[data-setup-ai-model-row]");
  const setupAiKeyRowNode = rootNode.querySelector<HTMLElement>("[data-setup-ai-key-row]");
  const setupAiProviderNode = rootNode.querySelector<HTMLInputElement>("[data-setup-ai-provider]");
  const setupAiModelNode = rootNode.querySelector<HTMLInputElement>("[data-setup-ai-model]");
  const setupAiKeyNode = rootNode.querySelector<HTMLInputElement>("[data-setup-ai-key]");
  const setupSourceSectionNode = rootNode.querySelector<HTMLElement>("[data-setup-source-section]");
  const setupSourceEnabledNode = rootNode.querySelector<HTMLInputElement>("[data-setup-source-enabled]");
  const setupSourceRowNode = rootNode.querySelector<HTMLElement>("[data-setup-source-row]");
  const setupSourceRefRowNode = rootNode.querySelector<HTMLElement>("[data-setup-source-ref-row]");
  const setupBootstrapSourceNode = rootNode.querySelector<HTMLInputElement>("[data-setup-bootstrap-source]");
  const setupBootstrapRefNode = rootNode.querySelector<HTMLInputElement>("[data-setup-bootstrap-ref]");
  const setupNodeSectionNode = rootNode.querySelector<HTMLElement>("[data-setup-node-section]");
  const setupNodeEnabledNode = rootNode.querySelector<HTMLInputElement>("[data-setup-node-enabled]");
  const setupNodeDeviceRowNode = rootNode.querySelector<HTMLElement>("[data-setup-node-device-row]");
  const setupNodeLabelRowNode = rootNode.querySelector<HTMLElement>("[data-setup-node-label-row]");
  const setupNodeExpiryRowNode = rootNode.querySelector<HTMLElement>("[data-setup-node-expiry-row]");
  const setupNodeDeviceIdNode = rootNode.querySelector<HTMLInputElement>("[data-setup-node-device-id]");
  const setupNodeLabelNode = rootNode.querySelector<HTMLInputElement>("[data-setup-node-label]");
  const setupNodeExpiryNode = rootNode.querySelector<HTMLInputElement>("[data-setup-node-expiry]");
  const setupGuidePanelNode = rootNode.querySelector<HTMLElement>("[data-setup-guide-panel]");
  const setupGuideLogNode = rootNode.querySelector<HTMLElement>("[data-setup-guide-log]");
  const setupGuideErrorNode = rootNode.querySelector<HTMLElement>("[data-setup-guide-error]");
  const setupGuideFormNode = rootNode.querySelector<HTMLElement>("[data-setup-guide-form]");
  const setupGuideInputNode = rootNode.querySelector<HTMLTextAreaElement>("[data-setup-guide-input]");
  const setupGuideSendNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-guide-send]");
  const setupGuideToggleNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-guide-toggle]");
  const setupSummaryLaneNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-lane]");
  const setupSummaryLaneCopyNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-lane-copy]");
  const setupSummaryAccountNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-account]");
  const setupSummaryAdminNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-admin]");
  const setupSummaryTimeZoneNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-timezone]");
  const setupSummaryAiNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-ai]");
  const setupSummarySourceNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-source]");
  const setupSummaryDeviceNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-device]");
  const setupContinueNode = rootNode.querySelector<HTMLButtonElement>("[data-session-setup-continue]");
  const provisioningTitleNode = rootNode.querySelector<HTMLElement>("[data-session-provisioning-title]");
  const provisioningCopyNode = rootNode.querySelector<HTMLElement>("[data-session-provisioning-copy]");
  const setupCopyCliNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-copy-cli]");
  const setupCopyTokenNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-copy-token]");
  const setupCompleteErrorNode = rootNode.querySelector<HTMLElement>("[data-session-setup-complete-error]");
  const setupResultUsernameNode = rootNode.querySelector<HTMLElement>("[data-setup-result-username]");
  const setupResultRootNode = rootNode.querySelector<HTMLElement>("[data-setup-result-root]");
  const setupResultSourceNode = rootNode.querySelector<HTMLElement>("[data-setup-result-source]");
  const setupResultRefNode = rootNode.querySelector<HTMLElement>("[data-setup-result-ref]");
  const setupResultCliLabelNode = rootNode.querySelector<HTMLElement>("[data-setup-result-cli-label]");
  const setupResultCliCommandNode = rootNode.querySelector<HTMLTextAreaElement>("[data-setup-result-cli-command]");
  const setupResultCliMetaNode = rootNode.querySelector<HTMLElement>("[data-setup-result-cli-meta]");
  const setupNodeResultNode = rootNode.querySelector<HTMLElement>("[data-setup-node-result]");
  const setupResultNodeLabelNode = rootNode.querySelector<HTMLElement>("[data-setup-result-node-label]");
  const setupResultNodeTokenNode = rootNode.querySelector<HTMLTextAreaElement>("[data-setup-result-node-token]");
  const setupResultNodeMetaNode = rootNode.querySelector<HTMLElement>("[data-setup-result-node-meta]");

  if (
    !screenNode ||
    !desktopRootNode ||
    !loginViewNode ||
    !setupViewNode ||
    !provisioningViewNode ||
    !setupCompleteNode ||
    !loginFormNode ||
    !setupFormNode ||
    !usernameInputNode ||
    !passwordInputNode ||
    !tokenInputNode ||
    !loginErrorNode ||
    !setupErrorNode ||
    !submitNode ||
    !dotNode ||
    !lockNode ||
    !setupHeadingNode ||
    !setupCopyNode ||
    setupStagePills.length === 0 ||
    setupDetailSections.length === 0 ||
    !setupWelcomeNode ||
    !setupDetailsNode ||
    !setupReviewNode ||
    setupLaneButtons.length === 0 ||
    !setupLaneKickerNode ||
    !setupDetailCopyNode ||
    !setupLaneTitleNode ||
    !setupLaneDescriptionNode ||
    !setupBackNode ||
    !setupNextNode ||
    !setupSubmitNode ||
    !setupUsernameNode ||
    !setupAgentNameNode ||
    !setupPasswordNode ||
    !setupPasswordConfirmNode ||
    !setupAdminCustomNode ||
    !setupRootRowNode ||
    !setupRootConfirmRowNode ||
    !setupRootPasswordNode ||
    !setupRootPasswordConfirmNode ||
    !setupTimeZoneNode ||
    !setupAiSectionNode ||
    !setupAiEnabledNode ||
    !setupAiProviderRowNode ||
    !setupAiModelRowNode ||
    !setupAiKeyRowNode ||
    !setupAiProviderNode ||
    !setupAiModelNode ||
    !setupAiKeyNode ||
    !setupSourceSectionNode ||
    !setupSourceEnabledNode ||
    !setupSourceRowNode ||
    !setupSourceRefRowNode ||
    !setupBootstrapSourceNode ||
    !setupBootstrapRefNode ||
    !setupNodeSectionNode ||
    !setupNodeEnabledNode ||
    !setupNodeDeviceRowNode ||
    !setupNodeLabelRowNode ||
    !setupNodeExpiryRowNode ||
    !setupNodeDeviceIdNode ||
    !setupNodeLabelNode ||
    !setupNodeExpiryNode ||
    !setupGuidePanelNode ||
    !setupGuideLogNode ||
    !setupGuideErrorNode ||
    !setupGuideFormNode ||
    !setupGuideInputNode ||
    !setupGuideSendNode ||
    !setupGuideToggleNode ||
    !setupSummaryLaneNode ||
    !setupSummaryLaneCopyNode ||
    !setupSummaryAccountNode ||
    !setupSummaryAdminNode ||
    !setupSummaryTimeZoneNode ||
    !setupSummaryAiNode ||
    !setupSummarySourceNode ||
    !setupSummaryDeviceNode ||
    !setupContinueNode ||
    !provisioningTitleNode ||
    !provisioningCopyNode ||
    !setupCopyCliNode ||
    !setupCopyTokenNode ||
    !setupCompleteErrorNode ||
    !setupResultUsernameNode ||
    !setupResultRootNode ||
    !setupResultSourceNode ||
    !setupResultRefNode ||
    !setupResultCliLabelNode ||
    !setupResultCliCommandNode ||
    !setupResultCliMetaNode ||
    !setupNodeResultNode ||
    !setupResultNodeLabelNode ||
    !setupResultNodeTokenNode ||
    !setupResultNodeMetaNode
  ) {
    throw new Error("Session UI markup is incomplete");
  }

  let sessionSnapshot = session.snapshot();
  const onboarding = createOnboardingService(session.client, sessionSnapshot.username);
  let onboardingSnapshot = onboarding.snapshot();
  let pendingAction: PendingAction = null;
  let lastAdminMode: AdminMode = onboardingSnapshot.draft.admin.mode;
  let loginValidationError: string | null = null;
  let setupValidationError: string | null = null;

  const setVisibleError = (node: HTMLElement, message: string | null): void => {
    if (message) {
      node.hidden = false;
      node.textContent = message;
      return;
    }
    node.hidden = true;
    node.textContent = "";
  };

  const populateTimeZoneOptions = (): void => {
    setupTimeZoneNode.replaceChildren();
    for (const zone of timeZoneOptions()) {
      const option = document.createElement("option");
      option.value = zone;
      option.textContent = zone;
      setupTimeZoneNode.appendChild(option);
    }
  };

  const ensureTimeZoneOption = (zone: string): void => {
    if (!zone || setupTimeZoneNode.querySelector(`option[value="${CSS.escape(zone)}"]`)) {
      return;
    }
    const option = document.createElement("option");
    option.value = zone;
    option.textContent = zone;
    setupTimeZoneNode.appendChild(option);
  };

  const activeLaneMeta = (): SetupLaneMeta => {
    return SETUP_LANE_META[onboardingSnapshot.draft.lane];
  };

  const detailStepsForLane = (lane = onboardingSnapshot.draft.lane): OnboardingDetailStep[] => {
    void lane;
    return ["account", "system"];
  };

  const currentDetailStep = (): OnboardingDetailStep => {
    const steps = detailStepsForLane();
    const current = onboardingSnapshot.draft.detailStep;
    if ((current === "admin" || current === "ai" || current === "source" || current === "device") && steps.includes("system")) {
      return "system";
    }
    return steps.includes(current) ? current : steps[0] ?? "account";
  };

  const advancedSectionsVisible = (): boolean => {
    return onboardingSnapshot.draft.lane === "customize" || onboardingSnapshot.draft.lane === "advanced";
  };

  const guideShortcutReady = (): boolean => {
    return onboardingSnapshot.draft.mode === "guided" && onboardingSnapshot.reviewReady;
  };

  const clearSetupError = (): void => {
    if (!setupValidationError) return;
    setupValidationError = null;
    render();
  };

  const updateDraft = (updater: (draft: OnboardingDraft) => OnboardingDraft): void => {
    setupValidationError = null;
    onboarding.updateDraft(updater);
  };

  const applyDraftToFields = (): void => {
    const { draft } = onboardingSnapshot;

    if (setupUsernameNode.value !== draft.account.username) setupUsernameNode.value = draft.account.username;
    if (setupAgentNameNode.value !== draft.account.agentName) setupAgentNameNode.value = draft.account.agentName;
    if (setupPasswordNode.value !== draft.account.password) setupPasswordNode.value = draft.account.password;
    if (setupPasswordConfirmNode.value !== draft.account.passwordConfirm) {
      setupPasswordConfirmNode.value = draft.account.passwordConfirm;
    }
    setupAdminCustomNode.checked = draft.admin.mode === "custom";
    if (setupRootPasswordNode.value !== draft.admin.password) setupRootPasswordNode.value = draft.admin.password;
    if (setupRootPasswordConfirmNode.value !== draft.admin.passwordConfirm) {
      setupRootPasswordConfirmNode.value = draft.admin.passwordConfirm;
    }
    ensureTimeZoneOption(draft.system.timezone);
    if (setupTimeZoneNode.value !== draft.system.timezone) setupTimeZoneNode.value = draft.system.timezone;

    setupAiEnabledNode.checked = draft.ai.enabled;
    if (setupAiProviderNode.value !== draft.ai.provider) setupAiProviderNode.value = draft.ai.provider;
    if (setupAiModelNode.value !== draft.ai.model) setupAiModelNode.value = draft.ai.model;
    if (setupAiKeyNode.value !== draft.ai.apiKey) setupAiKeyNode.value = draft.ai.apiKey;

    setupSourceEnabledNode.checked = draft.source.enabled;
    if (setupBootstrapSourceNode.value !== draft.source.value) setupBootstrapSourceNode.value = draft.source.value;
    if (setupBootstrapRefNode.value !== draft.source.ref) setupBootstrapRefNode.value = draft.source.ref;

    setupNodeEnabledNode.checked = draft.device.enabled;
    if (setupNodeDeviceIdNode.value !== draft.device.deviceId) setupNodeDeviceIdNode.value = draft.device.deviceId;
    if (setupNodeLabelNode.value !== draft.device.label) setupNodeLabelNode.value = draft.device.label;
    if (setupNodeExpiryNode.value !== draft.device.expiryDays) setupNodeExpiryNode.value = draft.device.expiryDays;

  };

  const applyDetailSections = (): void => {
    const activeStep = currentDetailStep();
    const showAdvanced = advancedSectionsVisible();
    for (const section of setupDetailSections) {
      const step = section.dataset.setupDetailStep;
      const hiddenForLane = !showAdvanced && (step === "ai" || step === "source" || step === "device");
      section.hidden = onboardingSnapshot.draft.stage !== "details" || step !== activeStep || hiddenForLane;
    }
  };

  const applyLanePresentation = (): void => {
    const meta = activeLaneMeta();
    const { stage } = onboardingSnapshot.draft;

    if (stage === "welcome") {
      setupHeadingNode.textContent = "Create account";
      setupCopyNode.textContent = "Choose a setup path.";
      setupLaneKickerNode.textContent = meta.kicker;
    } else {
      setupHeadingNode.textContent = "Create account";
      setupCopyNode.textContent = meta.estimate;
    }

    if (stage === "details") {
      const detailStep = currentDetailStep();
      setupDetailCopyNode.hidden = detailStep === "system";
      if (detailStep === "system") {
        setupLaneKickerNode.textContent = "Preferences";
        setupLaneTitleNode.textContent = "Preferences";
        setupLaneDescriptionNode.textContent = onboardingSnapshot.draft.lane === "quick"
          ? "Confirm timezone and decide whether admin actions need a separate password."
          : "Confirm timezone, admin security, and any custom AI, system files, or device settings.";
      } else {
        setupLaneKickerNode.textContent = "Login credentials";
        setupLaneTitleNode.textContent = "Desktop account";
        setupLaneDescriptionNode.textContent = "Create the first desktop account and secure it with a password.";
      }
    } else if (stage === "review") {
      setupDetailCopyNode.hidden = true;
      setupLaneKickerNode.textContent = "Review and start";
      setupLaneTitleNode.textContent = "Review and start";
      setupLaneDescriptionNode.textContent = "Confirm the setup plan before GSV opens the desktop.";
    } else {
      setupDetailCopyNode.hidden = true;
    }

    for (const button of setupLaneButtons) {
      button.classList.toggle("is-selected", button.dataset.setupLane === onboardingSnapshot.draft.lane);
    }
  };

  const syncOptionalSetupFields = (): void => {
    const { draft } = onboardingSnapshot;
    const showAdvanced = advancedSectionsVisible();
    const showAiRows = showAdvanced && draft.ai.enabled;
    const showSourceRows = showAdvanced && draft.source.enabled;
    const showNodeRows = showAdvanced && draft.device.enabled;

    setupRootRowNode.hidden = draft.admin.mode !== "custom";
    setupRootConfirmRowNode.hidden = draft.admin.mode !== "custom";
    setupRootPasswordNode.disabled = draft.admin.mode !== "custom";
    setupRootPasswordConfirmNode.disabled = draft.admin.mode !== "custom";

    setupAiSectionNode.hidden = !showAdvanced;
    setupAiEnabledNode.disabled = !showAdvanced;
    setupAiProviderRowNode.hidden = !showAiRows;
    setupAiModelRowNode.hidden = !showAiRows;
    setupAiKeyRowNode.hidden = !showAiRows;
    setupAiProviderNode.disabled = !showAiRows;
    setupAiModelNode.disabled = !showAiRows;
    setupAiKeyNode.disabled = !showAiRows;

    setupSourceSectionNode.hidden = !showAdvanced;
    setupSourceEnabledNode.disabled = !showAdvanced;
    setupSourceRowNode.hidden = !showSourceRows;
    setupSourceRefRowNode.hidden = !showSourceRows;
    setupBootstrapSourceNode.disabled = !showSourceRows;
    setupBootstrapRefNode.disabled = !showSourceRows;

    setupNodeSectionNode.hidden = !showAdvanced;
    setupNodeEnabledNode.disabled = !showAdvanced;
    setupNodeDeviceRowNode.hidden = !showNodeRows;
    setupNodeLabelRowNode.hidden = !showNodeRows;
    setupNodeExpiryRowNode.hidden = !showNodeRows;
    setupNodeDeviceIdNode.disabled = !showNodeRows;
    setupNodeLabelNode.disabled = !showNodeRows;
    setupNodeExpiryNode.disabled = !showNodeRows;
  };

  const renderGuideLog = (): void => {
    setupGuideLogNode.replaceChildren();

    if (onboardingSnapshot.messages.length === 0 && !onboardingSnapshot.busy) {
      const empty = document.createElement("div");
      empty.className = "onboarding-guide-empty";

      const title = document.createElement("strong");
      title.textContent = "Ask for setup help";

      const copy = document.createElement("p");
      copy.textContent = "System files, AI model, timezone, and device setup can be adjusted here. Secrets stay in the form.";

      empty.append(title, copy);
      setupGuideLogNode.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of onboardingSnapshot.messages) {
      const message = document.createElement("article");
      message.className = `onboarding-guide-message onboarding-guide-message-${entry.role}`;
      message.dataset.role = entry.role;

      const role = document.createElement("span");
      role.textContent = entry.role === "user" ? "You" : "Guide";

      const body = document.createElement("p");
      body.textContent = entry.content;

      message.append(role, body);
      fragment.appendChild(message);
    }

    if (onboardingSnapshot.busy) {
      const pending = document.createElement("article");
      pending.className = "onboarding-guide-message onboarding-guide-message-assistant is-pending";
      pending.dataset.role = "assistant";

      const role = document.createElement("span");
      role.textContent = "Guide";

      const body = document.createElement("p");
      body.textContent = "Working on it";

      pending.append(role, body);
      fragment.appendChild(pending);
    }

    setupGuideLogNode.appendChild(fragment);
    setupGuideLogNode.scrollTop = setupGuideLogNode.scrollHeight;
  };

  const renderGuidePanel = (): void => {
    const showToggle = onboardingSnapshot.draft.stage !== "welcome";
    const showPanel = showToggle && onboardingSnapshot.draft.mode === "guided";

    setupGuideToggleNode.hidden = !showToggle;
    setupGuideToggleNode.textContent = showPanel ? "Hide guide" : "Ask the guide";
    setupGuidePanelNode.hidden = !showPanel;
    setVisibleError(setupGuideErrorNode, showPanel ? onboardingSnapshot.error : null);
    setupGuideInputNode.disabled = !showPanel || onboardingSnapshot.busy || sessionSnapshot.phase === "authenticating";
    setupGuideSendNode.disabled = !showPanel || onboardingSnapshot.busy || sessionSnapshot.phase === "authenticating";

    if (showPanel) {
      renderGuideLog();
    } else {
      setupGuideLogNode.replaceChildren();
    }
  };

  const applySetupStage = (): void => {
    const { stage } = onboardingSnapshot.draft;
    const detailSteps = detailStepsForLane();
    const detailStep = currentDetailStep();

    setupFormNode.dataset.setupStage = stage;
    setupWelcomeNode.hidden = stage !== "welcome";
    setupDetailsNode.hidden = stage !== "details";
    setupReviewNode.hidden = stage !== "review";
    applyDetailSections();

    for (const pill of setupStagePills) {
      const pillStage = pill.dataset.setupStagePill as OnboardingStage | undefined;
      const railStep = pill.dataset.setupRailStep;
      const active =
        stage === "review"
          ? railStep === "review"
          : stage === "details" && (
            (railStep === "account" && detailStep === "account") ||
            (railStep === "preferences" && detailStep !== "account")
          );
      const complete =
        stage === "review"
          ? railStep === "account" || railStep === "preferences"
          : stage === "details" && railStep === "account" && detailStep !== "account";
      pill.classList.toggle("is-active", active || (stage === "welcome" && railStep === "account"));
      pill.classList.toggle("is-complete", complete);
      pill.classList.toggle("is-muted", pillStage !== stage && !active && !complete);
    }

    setupBackNode.hidden = stage === "welcome";
    setupNextNode.hidden = stage !== "details";
    setupSubmitNode.hidden = stage !== "review";
    setupNextNode.textContent = "Next";
  };

  const focusLoginField = (): void => {
    if (!usernameInputNode.value.trim()) {
      usernameInputNode.focus();
      return;
    }
    passwordInputNode.focus();
  };

  const focusSetupField = (): void => {
    const { stage } = onboardingSnapshot.draft;
    if (stage === "welcome") {
      setupLaneButtons[0]?.focus();
      return;
    }
    if (stage === "review") {
      setupSubmitNode.focus();
      return;
    }
    const activeSection = setupDetailSections.find((section) => !section.hidden);
    const firstVisible = activeSection?.querySelector<HTMLElement>("input:not([disabled]):not([type='hidden']), select:not([disabled])");
    firstVisible?.focus();
  };

  const validateSetupDetails = (validateAll = false): ValidationResult => {
    const { draft } = onboardingSnapshot;
    const steps = validateAll ? detailStepsForLane() : [currentDetailStep()];

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
          if (draft.admin.password.trim().length < 8) {
            return { message: "Admin password must be at least 8 characters.", step };
          }
          if (draft.admin.password !== draft.admin.passwordConfirm) {
            return { message: "Admin passwords do not match.", step };
          }
        }
        if (advancedSectionsVisible() && draft.ai.enabled) {
          if (!draft.ai.provider.trim()) {
            return { message: "AI service is required when customizing AI settings.", step };
          }
          if (!draft.ai.model.trim()) {
            return { message: "AI model is required when customizing AI settings.", step };
          }
        }
        if (advancedSectionsVisible() && draft.source.enabled && !draft.source.value.trim()) {
          return { message: "System files location is required when using custom system files.", step };
        }
        if (advancedSectionsVisible() && draft.device.enabled) {
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
  };

  const buildSourceSummary = (): string => {
    const { draft } = onboardingSnapshot;
    if (!advancedSectionsVisible() || !draft.source.enabled) {
      return DEFAULT_SOURCE_LABEL;
    }
    const source = draft.source.value.trim();
    const ref = draft.source.ref.trim();
    if (!source) {
      return DEFAULT_SOURCE_LABEL;
    }
    return ref ? `${source}#${ref}` : source;
  };

  const buildAiSummary = (): string => {
    const { draft } = onboardingSnapshot;
    if (!advancedSectionsVisible() || !draft.ai.enabled) {
      return "Use default AI";
    }
    const provider = draft.ai.provider.trim();
    const model = draft.ai.model.trim();
    return provider && model ? `${provider} / ${model}` : "Custom AI settings";
  };

  const buildDeviceSummary = (): string => {
    const { draft } = onboardingSnapshot;
    if (!advancedSectionsVisible() || !draft.device.enabled) {
      return "Do not create a device setup key";
    }
    const deviceId = draft.device.deviceId.trim();
    return deviceId ? `Create setup key for ${deviceId}` : "Create device setup key";
  };

  const renderReviewSummary = (): void => {
    const meta = activeLaneMeta();
    const { draft } = onboardingSnapshot;
    const username = draft.account.username.trim();
    const agentName = draft.account.agentName.trim();

    setupSummaryLaneNode.textContent = meta.label;
    setupSummaryLaneCopyNode.textContent = meta.reviewCopy;
    setupSummaryAccountNode.textContent = agentName
      ? `${username} · agent ${agentName}`
      : `${username} · default personal agent`;
    setupSummaryAdminNode.textContent = draft.admin.mode === "custom"
      ? "Extra admin security layer configured"
      : "Account password protects admin tasks";
    setupSummaryTimeZoneNode.textContent = draft.system.timezone.trim() || browserTimeZone();
    setupSummaryAiNode.textContent = buildAiSummary();
    setupSummarySourceNode.textContent = buildSourceSummary();
    setupSummaryDeviceNode.textContent = buildDeviceSummary();
  };

  const buildSetupPayload = (): SessionSetupInput => {
    const { draft } = onboardingSnapshot;
    const agentName = draft.account.agentName.trim();
    const payload: SessionSetupInput = {
      username: draft.account.username.trim(),
      password: draft.account.password,
      timezone: draft.system.timezone.trim(),
    };

    if (agentName) {
      payload.agentName = agentName;
    }

    if (draft.admin.mode === "custom" && draft.admin.password.trim()) {
      payload.rootPassword = draft.admin.password.trim();
    }

    if (advancedSectionsVisible() && draft.ai.enabled) {
      payload.ai = {
        provider: draft.ai.provider.trim(),
        model: draft.ai.model.trim(),
        ...(draft.ai.apiKey.trim() ? { apiKey: draft.ai.apiKey.trim() } : {}),
      };
    }

    if (advancedSectionsVisible() && draft.source.enabled) {
      const source = draft.source.value.trim();
      const ref = draft.source.ref.trim();
      payload.bootstrap = sourceLooksLikeRemote(source)
        ? { remoteUrl: source }
        : { repo: source };
      if (ref) {
        payload.bootstrap.ref = ref;
      }
    }

    if (advancedSectionsVisible() && draft.device.enabled) {
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
  };

  const renderSetupResult = (snapshot: SessionSnapshot): void => {
    const result = snapshot.setupResult;
    const adminMode = onboardingSnapshot.draft.admin.mode ?? lastAdminMode;
    const origin = gatewayOrigin();
    const platform = detectBrowserInstallPlatform();
    const defaultChannel = result?.bootstrap?.cli.defaultChannel ?? "stable";
    setupResultCliLabelNode.textContent = `Tools for ${installPlatformLabel(platform)}`;
    setupResultCliCommandNode.value = cliInstallCommand(origin, platform);
    setupResultCliMetaNode.textContent = platform === "windows"
      ? `Uses the ${defaultChannel} release channel. The PowerShell installer will report clearly if Windows tools are not available yet.`
      : `Uses the ${defaultChannel} release channel and picks the right tools for this machine.`;
    if (!result) {
      setupResultUsernameNode.textContent = snapshot.username || "Unknown";
      setupResultRootNode.textContent = adminMode === "custom" ? "Extra admin security layer" : "Account password";
      setupResultSourceNode.textContent = DEFAULT_SOURCE_LABEL;
      setupResultRefNode.textContent = DEFAULT_SOURCE_REF;
      setupNodeResultNode.hidden = true;
      setupResultNodeTokenNode.value = "";
      setupResultNodeMetaNode.textContent = "";
      return;
    }

    setupResultUsernameNode.textContent = result.user.username;
    setupResultRootNode.textContent = adminMode === "custom" ? "Extra admin security layer" : "Account password";
    setupResultSourceNode.textContent = result.bootstrap?.remoteUrl ?? DEFAULT_SOURCE_LABEL;
    setupResultRefNode.textContent = result.bootstrap?.ref ?? DEFAULT_SOURCE_REF;

    if (!result.nodeToken) {
      setupNodeResultNode.hidden = true;
      setupResultNodeTokenNode.value = "";
      setupResultNodeMetaNode.textContent = "";
      return;
    }

    const deviceId = result.nodeToken.allowedDeviceId ?? "node-id";
    const bootstrapCommand = buildNodeBootstrapCommand(origin, platform, deviceId, result.nodeToken.token);
    const expiresLabel = typeof result.nodeToken.expiresAt === "number"
      ? `Expires ${new Date(result.nodeToken.expiresAt).toLocaleString()}`
      : "No expiry";

    setupNodeResultNode.hidden = false;
    setupResultNodeLabelNode.textContent = result.nodeToken.label ?? deviceId;
    setupResultNodeTokenNode.value = bootstrapCommand;
    setupResultNodeMetaNode.textContent = `${deviceId} · ${expiresLabel} · ${installPlatformLabel(platform)} setup steps shown`;
  };

  const resolveVisibleView = (snapshot: SessionSnapshot): "login" | "setup" | "provisioning" | "complete" | "desktop" => {
    if (snapshot.phase === "ready") {
      return "desktop";
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
    if (snapshot.phase === "authenticating") {
      return "login";
    }
    return "login";
  };

  const render = (): void => {
    if (statusNode) {
      statusNode.textContent = statusText(sessionSnapshot);
    }
    if (mobileHomeUsernameNode) {
      mobileHomeUsernameNode.textContent = sessionSnapshot.username || "operator";
    }
    if (mobileHomeDateNode) {
      mobileHomeDateNode.textContent = new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
      }).format(new Date());
    }

    if (sessionSnapshot.phase === "setup-complete" || sessionSnapshot.phase === "ready") {
      pendingAction = null;
    }

    const visibleView = resolveVisibleView(sessionSnapshot);
    const ready = visibleView === "desktop";
    screenNode.hidden = ready;
    desktopRootNode.hidden = !ready;
    loginViewNode.hidden = visibleView !== "login";
    setupViewNode.hidden = visibleView !== "setup";
    provisioningViewNode.hidden = visibleView !== "provisioning";
    setupCompleteNode.hidden = visibleView !== "complete";

    if (pendingAction === "setup") {
      provisioningTitleNode.textContent = "Setting up your workspace";
      provisioningCopyNode.textContent = "Creating your account, preparing system files, and opening the desktop.";
    } else if (pendingAction === "continue") {
      provisioningTitleNode.textContent = "Opening desktop";
      provisioningCopyNode.textContent = "Loading your desktop.";
    } else {
      provisioningTitleNode.textContent = "Setting up your workspace";
      provisioningCopyNode.textContent = "Preparing the first session.";
    }

    submitNode.disabled = sessionSnapshot.phase === "authenticating";
    setupBackNode.disabled = sessionSnapshot.phase === "authenticating";
    setupNextNode.disabled = sessionSnapshot.phase === "authenticating";
    setupSubmitNode.disabled = sessionSnapshot.phase === "authenticating";
    setupContinueNode.disabled = sessionSnapshot.phase === "authenticating";
    lockNode.disabled = sessionSnapshot.phase !== "ready";

    dotNode.classList.toggle("is-online", sessionSnapshot.phase === "ready");
    dotNode.classList.toggle("is-pending", sessionSnapshot.phase === "authenticating");
    dotNode.classList.toggle("is-offline", sessionSnapshot.phase !== "ready" && sessionSnapshot.phase !== "authenticating");

    setVisibleError(
      loginErrorNode,
      sessionSnapshot.phase === "locked" && sessionSnapshot.message ? sessionSnapshot.message : loginValidationError,
    );
    setVisibleError(
      setupErrorNode,
      sessionSnapshot.phase === "setup" && sessionSnapshot.message ? sessionSnapshot.message : setupValidationError,
    );
    setVisibleError(
      setupCompleteErrorNode,
      sessionSnapshot.phase === "setup-complete" && sessionSnapshot.message ? sessionSnapshot.message : null,
    );

    if (sessionSnapshot.phase === "ready") {
      passwordInputNode.value = "";
      tokenInputNode.value = "";
      return;
    }

    applyDraftToFields();
    applyLanePresentation();
    syncOptionalSetupFields();
    applySetupStage();
    renderGuidePanel();
    renderReviewSummary();

    if (visibleView === "login") {
      focusLoginField();
      return;
    }
    if (visibleView === "complete") {
      renderSetupResult(sessionSnapshot);
      setupContinueNode.focus();
    }
  };

  const syncUsernameFromSession = (): void => {
    if (!sessionSnapshot.username || onboardingSnapshot.draft.account.username.trim()) {
      return;
    }
    onboarding.updateDraft((draft) => ({
      ...draft,
      account: {
        ...draft.account,
        username: sessionSnapshot.username,
      },
    }));
  };

  const onLoginSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();

    const username = usernameInputNode.value.trim();
    const password = passwordInputNode.value.trim();
    const token = tokenInputNode.value.trim();

    if (!username) {
      loginValidationError = "Username is required.";
      render();
      return;
    }
    if (!password && !token) {
      loginValidationError = "Provide password or token.";
      render();
      return;
    }
    if (password && token) {
      loginValidationError = "Use either password or token.";
      render();
      return;
    }

    loginValidationError = null;
    pendingAction = "login";
    render();

    try {
      await session.login({
        username,
        ...(token ? { token } : { password }),
      });
    } catch {
      // Error is reflected through session snapshot.
    }
  };

  const onSetupLaneClick = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) return;
    const nextLane = target.dataset.setupLane;
    if (nextLane !== "quick" && nextLane !== "customize" && nextLane !== "advanced") return;
    setupValidationError = null;
    onboarding.setLane(nextLane);
    focusSetupField();
  };

  const onSetupBackClick = (): void => {
    setupValidationError = null;
    if (onboardingSnapshot.draft.stage === "review") {
      onboarding.setStage("details");
      focusSetupField();
      return;
    }

    const steps = detailStepsForLane();
    const currentIndex = steps.indexOf(currentDetailStep());
    if (currentIndex > 0) {
      onboarding.setDetailStep(steps[currentIndex - 1] ?? "account");
    } else {
      onboarding.setStage("welcome");
    }
    focusSetupField();
  };

  const onSetupNextClick = (): void => {
    const jumpToReview = guideShortcutReady();
    const validation = validateSetupDetails(jumpToReview);
    if (validation.message) {
      setupValidationError = validation.message;
      if (validation.step && validation.step !== currentDetailStep()) {
        onboarding.setDetailStep(validation.step);
      } else {
        render();
      }
      return;
    }

    setupValidationError = null;
    const steps = detailStepsForLane();
    const currentIndex = steps.indexOf(currentDetailStep());
    const lastIndex = steps.length - 1;
    if (jumpToReview || currentIndex >= lastIndex) {
      onboarding.setStage("review");
    } else {
      onboarding.setDetailStep(steps[currentIndex + 1] ?? steps[lastIndex] ?? "account");
    }
    focusSetupField();
  };

  const onSetupSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();

    const validation = validateSetupDetails(true);
    if (validation.message) {
      setupValidationError = validation.message;
      onboarding.setStage("details");
      if (validation.step) {
        onboarding.setDetailStep(validation.step);
      }
      return;
    }

    if (onboardingSnapshot.draft.stage !== "review") {
      setupValidationError = null;
      onboarding.setStage("review");
      return;
    }

    pendingAction = "setup";
    lastAdminMode = onboardingSnapshot.draft.admin.mode;
    render();

    try {
      await session.setup(buildSetupPayload());
    } catch {
      pendingAction = null;
      render();
      // Error is reflected through session snapshot.
    }
  };

  const onSetupContinue = async (): Promise<void> => {
    pendingAction = "continue";
    render();

    try {
      await session.continueFromSetup();
    } catch {
      pendingAction = null;
      render();
      // Error is reflected through session snapshot.
    }
  };

  const onCopyToken = async (): Promise<void> => {
    if (!setupResultNodeTokenNode.value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(setupResultNodeTokenNode.value);
    } catch {
      setupResultNodeTokenNode.select();
    }
  };

  const onCopyCli = async (): Promise<void> => {
    if (!setupResultCliCommandNode.value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(setupResultCliCommandNode.value);
    } catch {
      setupResultCliCommandNode.select();
    }
  };

  const onLockClick = (): void => {
    session.lock();
  };

  const onGuideToggleClick = (): void => {
    clearSetupError();
    const nextMode = onboardingSnapshot.draft.mode === "guided" ? "manual" : "guided";
    onboarding.setMode(nextMode);
    if (nextMode === "guided") {
      window.setTimeout(() => setupGuideInputNode.focus(), 0);
    }
  };

  const onGuideSend = async (): Promise<void> => {
    const message = setupGuideInputNode.value.trim();
    if (!message || onboardingSnapshot.busy) {
      return;
    }
    setupGuideInputNode.value = "";
    await onboarding.assist(message);
    setupGuideInputNode.focus();
  };

  const onGuideInputKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter") return;
    if (event.shiftKey) return;
    event.preventDefault();
    void onGuideSend();
  };
  const onGuideSendClick = (): void => {
    void onGuideSend();
  };
  const onLoginFieldInput = (): void => {
    if (!loginValidationError) return;
    loginValidationError = null;
    render();
  };

  loginFormNode.addEventListener("submit", onLoginSubmit);
  setupFormNode.addEventListener("submit", onSetupSubmit);
  setupBackNode.addEventListener("click", onSetupBackClick);
  setupNextNode.addEventListener("click", onSetupNextClick);
  setupContinueNode.addEventListener("click", onSetupContinue);
  setupCopyCliNode.addEventListener("click", onCopyCli);
  setupCopyTokenNode.addEventListener("click", onCopyToken);
  lockNode.addEventListener("click", onLockClick);
  for (const button of setupLaneButtons) {
    button.addEventListener("click", onSetupLaneClick);
  }
  usernameInputNode.addEventListener("input", onLoginFieldInput);
  passwordInputNode.addEventListener("input", onLoginFieldInput);
  tokenInputNode.addEventListener("input", onLoginFieldInput);

  setupUsernameNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      account: {
        ...draft.account,
        username: setupUsernameNode.value,
      },
    }));
  });
  setupAgentNameNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      account: {
        ...draft.account,
        agentName: setupAgentNameNode.value,
      },
    }));
  });
  setupPasswordNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      account: {
        ...draft.account,
        password: setupPasswordNode.value,
      },
    }));
  });
  setupPasswordConfirmNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      account: {
        ...draft.account,
        passwordConfirm: setupPasswordConfirmNode.value,
      },
    }));
  });
  setupAdminCustomNode.addEventListener("change", () => {
    updateDraft((draft) => ({
      ...draft,
      admin: {
        ...draft.admin,
        mode: setupAdminCustomNode.checked ? "custom" : "same",
      },
    }));
  });
  setupRootPasswordNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      admin: {
        ...draft.admin,
        password: setupRootPasswordNode.value,
      },
    }));
  });
  setupRootPasswordConfirmNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      admin: {
        ...draft.admin,
        passwordConfirm: setupRootPasswordConfirmNode.value,
      },
    }));
  });
  setupTimeZoneNode.addEventListener("change", () => {
    updateDraft((draft) => ({
      ...draft,
      system: {
        ...draft.system,
        timezone: setupTimeZoneNode.value,
      },
    }));
  });
  setupAiEnabledNode.addEventListener("change", () => {
    updateDraft((draft) => ({
      ...draft,
      ai: {
        ...draft.ai,
        enabled: setupAiEnabledNode.checked,
      },
    }));
  });
  setupAiProviderNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      ai: {
        ...draft.ai,
        provider: setupAiProviderNode.value,
      },
    }));
  });
  setupAiModelNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      ai: {
        ...draft.ai,
        model: setupAiModelNode.value,
      },
    }));
  });
  setupAiKeyNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      ai: {
        ...draft.ai,
        apiKey: setupAiKeyNode.value,
      },
    }));
  });
  setupSourceEnabledNode.addEventListener("change", () => {
    updateDraft((draft) => ({
      ...draft,
      source: {
        ...draft.source,
        enabled: setupSourceEnabledNode.checked,
      },
    }));
  });
  setupBootstrapSourceNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      source: {
        ...draft.source,
        value: setupBootstrapSourceNode.value,
      },
    }));
  });
  setupBootstrapRefNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      source: {
        ...draft.source,
        ref: setupBootstrapRefNode.value,
      },
    }));
  });
  setupNodeEnabledNode.addEventListener("change", () => {
    updateDraft((draft) => ({
      ...draft,
      device: {
        ...draft.device,
        enabled: setupNodeEnabledNode.checked,
      },
    }));
  });
  setupNodeDeviceIdNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      device: {
        ...draft.device,
        deviceId: setupNodeDeviceIdNode.value,
      },
    }));
  });
  setupNodeLabelNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      device: {
        ...draft.device,
        label: setupNodeLabelNode.value,
      },
    }));
  });
  setupNodeExpiryNode.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      device: {
        ...draft.device,
        expiryDays: setupNodeExpiryNode.value,
      },
    }));
  });
  setupGuideToggleNode.addEventListener("click", onGuideToggleClick);
  setupGuideSendNode.addEventListener("click", onGuideSendClick);
  setupGuideInputNode.addEventListener("keydown", onGuideInputKeyDown);

  const unsubscribeSession = session.subscribe((snapshot) => {
    sessionSnapshot = snapshot;
    syncUsernameFromSession();
    render();
  });
  const unsubscribeOnboarding = onboarding.subscribe((snapshot) => {
    onboardingSnapshot = snapshot;
    render();
  });

  populateTimeZoneOptions();
  render();

  return {
    destroy: () => {
      unsubscribeSession();
      unsubscribeOnboarding();
      loginFormNode.removeEventListener("submit", onLoginSubmit);
      setupFormNode.removeEventListener("submit", onSetupSubmit);
      setupBackNode.removeEventListener("click", onSetupBackClick);
      setupNextNode.removeEventListener("click", onSetupNextClick);
      setupContinueNode.removeEventListener("click", onSetupContinue);
      setupCopyCliNode.removeEventListener("click", onCopyCli);
      setupCopyTokenNode.removeEventListener("click", onCopyToken);
      lockNode.removeEventListener("click", onLockClick);
      for (const button of setupLaneButtons) {
        button.removeEventListener("click", onSetupLaneClick);
      }
      usernameInputNode.removeEventListener("input", onLoginFieldInput);
      passwordInputNode.removeEventListener("input", onLoginFieldInput);
      tokenInputNode.removeEventListener("input", onLoginFieldInput);
      setupGuideToggleNode.removeEventListener("click", onGuideToggleClick);
      setupGuideSendNode.removeEventListener("click", onGuideSendClick);
      setupGuideInputNode.removeEventListener("keydown", onGuideInputKeyDown);
    },
  };
}
