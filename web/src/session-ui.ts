import type { SessionService, SessionSnapshot, SessionSetupInput } from "./session-service";
import { createOnboardingService } from "./onboarding-service";
import type {
  OnboardingDetailStep,
  OnboardingDraft,
  OnboardingLane,
  OnboardingStage,
} from "../../gateway/src/syscalls/system";

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
};

type ValidationResult = {
  message: string | null;
  step?: OnboardingDetailStep;
};

const DEFAULT_SOURCE_LABEL = "Default upstream (deathbyknowledge/gsv#osify)";
const DEFAULT_SOURCE_REF = "osify";

const SETUP_LANE_META: Record<OnboardingLane, SetupLaneMeta> = {
  quick: {
    label: "Quick start",
    kicker: "Quick start",
    title: "Create the first operator",
    description: "Use the default system source and the default AI path. You only need the account and admin credentials.",
    reviewCopy: "Fastest path with the default system source and default AI configuration.",
  },
  customize: {
    label: "Customize",
    kicker: "Customize",
    title: "Tune the parts that matter",
    description: "Adjust AI defaults, first-boot system source, and optional device bootstrap without dealing with every low-level detail.",
    reviewCopy: "Guided setup with optional AI, source, and device customization.",
  },
  advanced: {
    label: "Advanced",
    kicker: "Advanced",
    title: "Take full control from first boot",
    description: "Choose the exact source and ref up front, configure AI explicitly, and issue node credentials during provisioning if needed.",
    reviewCopy: "Full-control setup with explicit first-boot source and runtime choices.",
  },
};

function statusText(snapshot: SessionSnapshot): string {
  switch (snapshot.phase) {
    case "ready":
      return "session: connected";
    case "setup":
      return "session: setup required";
    case "setup-complete":
      return "session: provisioning complete";
    case "authenticating":
      return "session: provisioning...";
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

function sourceLooksLikeRemote(value: string): boolean {
  return value.includes("://") || value.startsWith("git@");
}

export function createSessionUi(options: SessionUiOptions): SessionUiController {
  const { rootNode, session } = options;

  const screenNode = rootNode.querySelector<HTMLElement>("[data-session-screen]");
  const desktopRootNode = rootNode.querySelector<HTMLElement>("[data-desktop-root]");
  const loginViewNode = rootNode.querySelector<HTMLElement>("[data-session-login-view]");
  const setupViewNode = rootNode.querySelector<HTMLElement>("[data-session-setup-view]");
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
  const setupHeadingNode = rootNode.querySelector<HTMLElement>("[data-setup-heading]");
  const setupCopyNode = rootNode.querySelector<HTMLElement>("[data-setup-copy]");
  const setupStagePills = Array.from(rootNode.querySelectorAll<HTMLElement>("[data-setup-stage-pill]"));
  const setupDetailSections = Array.from(rootNode.querySelectorAll<HTMLElement>("[data-setup-detail-step]"));
  const setupWelcomeNode = rootNode.querySelector<HTMLElement>("[data-setup-stage='welcome']");
  const setupDetailsNode = rootNode.querySelector<HTMLElement>("[data-setup-stage='details']");
  const setupReviewNode = rootNode.querySelector<HTMLElement>("[data-setup-stage='review']");
  const setupLaneButtons = Array.from(rootNode.querySelectorAll<HTMLButtonElement>("[data-setup-lane]"));
  const setupLaneKickerNode = rootNode.querySelector<HTMLElement>("[data-setup-lane-kicker]");
  const setupLaneTitleNode = rootNode.querySelector<HTMLElement>("[data-setup-lane-title]");
  const setupLaneDescriptionNode = rootNode.querySelector<HTMLElement>("[data-setup-lane-description]");
  const setupBackNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-back]");
  const setupNextNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-next]");
  const setupSubmitNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-submit]");
  const setupUsernameNode = rootNode.querySelector<HTMLInputElement>("[data-setup-username]");
  const setupPasswordNode = rootNode.querySelector<HTMLInputElement>("[data-setup-password]");
  const setupPasswordConfirmNode = rootNode.querySelector<HTMLInputElement>("[data-setup-password-confirm]");
  const setupAdminSameNode = rootNode.querySelector<HTMLInputElement>("[data-setup-admin-same]");
  const setupAdminCustomNode = rootNode.querySelector<HTMLInputElement>("[data-setup-admin-custom]");
  const setupRootRowNode = rootNode.querySelector<HTMLElement>("[data-setup-root-row]");
  const setupRootPasswordNode = rootNode.querySelector<HTMLInputElement>("[data-setup-root-password]");
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
  const setupAssistToggleNode = rootNode.querySelector<HTMLElement>("[data-setup-assist-toggle]");
  const setupModeManualNode = rootNode.querySelector<HTMLInputElement>("[data-setup-mode-manual]");
  const setupModeGuidedNode = rootNode.querySelector<HTMLInputElement>("[data-setup-mode-guided]");
  const setupGuidePanelNode = rootNode.querySelector<HTMLElement>("[data-setup-guide-panel]");
  const setupGuideLogNode = rootNode.querySelector<HTMLElement>("[data-setup-guide-log]");
  const setupGuideErrorNode = rootNode.querySelector<HTMLElement>("[data-setup-guide-error]");
  const setupGuideFormNode = rootNode.querySelector<HTMLElement>("[data-setup-guide-form]");
  const setupGuideInputNode = rootNode.querySelector<HTMLInputElement>("[data-setup-guide-input]");
  const setupGuideSendNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-guide-send]");
  const setupSummaryLaneNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-lane]");
  const setupSummaryLaneCopyNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-lane-copy]");
  const setupSummaryAccountNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-account]");
  const setupSummaryAdminNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-admin]");
  const setupSummaryAiNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-ai]");
  const setupSummarySourceNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-source]");
  const setupSummaryDeviceNode = rootNode.querySelector<HTMLElement>("[data-setup-summary-device]");
  const setupContinueNode = rootNode.querySelector<HTMLButtonElement>("[data-session-setup-continue]");
  const setupCopyTokenNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-copy-token]");
  const setupCompleteErrorNode = rootNode.querySelector<HTMLElement>("[data-session-setup-complete-error]");
  const setupResultUsernameNode = rootNode.querySelector<HTMLElement>("[data-setup-result-username]");
  const setupResultRootNode = rootNode.querySelector<HTMLElement>("[data-setup-result-root]");
  const setupResultSourceNode = rootNode.querySelector<HTMLElement>("[data-setup-result-source]");
  const setupResultRefNode = rootNode.querySelector<HTMLElement>("[data-setup-result-ref]");
  const setupNodeResultNode = rootNode.querySelector<HTMLElement>("[data-setup-node-result]");
  const setupResultNodeLabelNode = rootNode.querySelector<HTMLElement>("[data-setup-result-node-label]");
  const setupResultNodeTokenNode = rootNode.querySelector<HTMLTextAreaElement>("[data-setup-result-node-token]");
  const setupResultNodeMetaNode = rootNode.querySelector<HTMLElement>("[data-setup-result-node-meta]");

  if (
    !screenNode ||
    !desktopRootNode ||
    !loginViewNode ||
    !setupViewNode ||
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
    !setupLaneTitleNode ||
    !setupLaneDescriptionNode ||
    !setupBackNode ||
    !setupNextNode ||
    !setupSubmitNode ||
    !setupUsernameNode ||
    !setupPasswordNode ||
    !setupPasswordConfirmNode ||
    !setupAdminSameNode ||
    !setupAdminCustomNode ||
    !setupRootRowNode ||
    !setupRootPasswordNode ||
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
    !setupAssistToggleNode ||
    !setupModeManualNode ||
    !setupModeGuidedNode ||
    !setupGuidePanelNode ||
    !setupGuideLogNode ||
    !setupGuideErrorNode ||
    !setupGuideFormNode ||
    !setupGuideInputNode ||
    !setupGuideSendNode ||
    !setupSummaryLaneNode ||
    !setupSummaryLaneCopyNode ||
    !setupSummaryAccountNode ||
    !setupSummaryAdminNode ||
    !setupSummaryAiNode ||
    !setupSummarySourceNode ||
    !setupSummaryDeviceNode ||
    !setupContinueNode ||
    !setupCopyTokenNode ||
    !setupCompleteErrorNode ||
    !setupResultUsernameNode ||
    !setupResultRootNode ||
    !setupResultSourceNode ||
    !setupResultRefNode ||
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

  const activeLaneMeta = (): SetupLaneMeta => {
    return SETUP_LANE_META[onboardingSnapshot.draft.lane];
  };

  const detailStepsForLane = (lane = onboardingSnapshot.draft.lane): OnboardingDetailStep[] => {
    if (lane === "quick") return ["account", "admin"];
    return ["account", "admin", "ai", "source", "device"];
  };

  const currentDetailStep = (): OnboardingDetailStep => {
    const steps = detailStepsForLane();
    const current = onboardingSnapshot.draft.detailStep;
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
    if (setupPasswordNode.value !== draft.account.password) setupPasswordNode.value = draft.account.password;
    if (setupPasswordConfirmNode.value !== draft.account.passwordConfirm) {
      setupPasswordConfirmNode.value = draft.account.passwordConfirm;
    }
    setupAdminSameNode.checked = draft.admin.mode === "same";
    setupAdminCustomNode.checked = draft.admin.mode === "custom";
    if (setupRootPasswordNode.value !== draft.admin.password) setupRootPasswordNode.value = draft.admin.password;

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

    setupModeManualNode.checked = draft.mode === "manual";
    setupModeGuidedNode.checked = draft.mode === "guided";
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
      setupHeadingNode.textContent = "Bring this gateway online";
      setupCopyNode.textContent = "Choose how much control you want, then review the exact plan before provisioning.";
      setupLaneKickerNode.textContent = meta.kicker;
    } else {
      setupHeadingNode.textContent = meta.label;
      setupCopyNode.textContent = meta.description;
      setupLaneKickerNode.textContent = meta.kicker;
    }

    if (stage === "details") {
      const detailStep = currentDetailStep();
      if (detailStep === "admin") {
        setupLaneTitleNode.textContent = "Set admin access";
        setupLaneDescriptionNode.textContent = "Choose whether admin access should use the same password as the first user or a separate password.";
      } else if (detailStep === "ai") {
        setupLaneTitleNode.textContent = "Configure AI defaults";
        setupLaneDescriptionNode.textContent = "Keep the default provider path or customize the initial AI provider, model, and API key.";
      } else if (detailStep === "source") {
        setupLaneTitleNode.textContent = "Choose the system source";
        setupLaneDescriptionNode.textContent = "The system source is bootstrapped during first setup. Leave it on the default upstream or point at a custom repository and ref.";
      } else if (detailStep === "device") {
        setupLaneTitleNode.textContent = "Bootstrap a device";
        setupLaneDescriptionNode.textContent = "Issue a node token now if you want a machine to connect immediately after setup.";
      } else {
        setupLaneTitleNode.textContent = meta.title;
        setupLaneDescriptionNode.textContent = meta.description;
      }
    } else {
      setupLaneTitleNode.textContent = meta.title;
      setupLaneDescriptionNode.textContent = meta.description;
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
    setupRootPasswordNode.disabled = draft.admin.mode !== "custom";

    setupAiEnabledNode.disabled = !showAdvanced;
    setupAiProviderRowNode.hidden = !showAiRows;
    setupAiModelRowNode.hidden = !showAiRows;
    setupAiKeyRowNode.hidden = !showAiRows;
    setupAiProviderNode.disabled = !showAiRows;
    setupAiModelNode.disabled = !showAiRows;
    setupAiKeyNode.disabled = !showAiRows;

    setupSourceEnabledNode.disabled = !showAdvanced;
    setupSourceRowNode.hidden = !showSourceRows;
    setupSourceRefRowNode.hidden = !showSourceRows;
    setupBootstrapSourceNode.disabled = !showSourceRows;
    setupBootstrapRefNode.disabled = !showSourceRows;

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
      const empty = document.createElement("p");
      empty.className = "session-copy";
      empty.textContent = "Describe the setup you want. The guide will patch only non-secret fields like source, model, and device settings.";
      setupGuideLogNode.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of onboardingSnapshot.messages) {
      const message = document.createElement("article");
      message.className = `onboarding-guide-message onboarding-guide-message-${entry.role}`;

      const role = document.createElement("span");
      role.className = "session-kicker";
      role.textContent = entry.role === "user" ? "You" : "Guide";

      const body = document.createElement("p");
      body.textContent = entry.content;

      message.append(role, body);
      fragment.appendChild(message);
    }

    if (onboardingSnapshot.busy) {
      const pending = document.createElement("article");
      pending.className = "onboarding-guide-message onboarding-guide-message-assistant";

      const role = document.createElement("span");
      role.className = "session-kicker";
      role.textContent = "Guide";

      const body = document.createElement("p");
      body.textContent = "Thinking...";

      pending.append(role, body);
      fragment.appendChild(pending);
    }

    setupGuideLogNode.appendChild(fragment);
    setupGuideLogNode.scrollTop = setupGuideLogNode.scrollHeight;
  };

  const renderGuidePanel = (): void => {
    const showToggle = onboardingSnapshot.draft.stage === "details" && onboardingSnapshot.draft.lane !== "advanced";
    const showPanel = showToggle && onboardingSnapshot.draft.mode === "guided";

    setupAssistToggleNode.hidden = !showToggle;
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
    const lastDetailStep = detailSteps[detailSteps.length - 1];

    setupWelcomeNode.hidden = stage !== "welcome";
    setupDetailsNode.hidden = stage !== "details";
    setupReviewNode.hidden = stage !== "review";
    applyDetailSections();

    for (const pill of setupStagePills) {
      const pillStage = pill.dataset.setupStagePill as OnboardingStage | undefined;
      pill.classList.toggle("is-active", pillStage === stage);
      pill.classList.toggle(
        "is-complete",
        (stage === "details" && pillStage === "welcome") ||
          (stage === "review" && (pillStage === "welcome" || pillStage === "details")),
      );
    }

    setupBackNode.hidden = stage === "welcome";
    setupNextNode.hidden = stage !== "details";
    setupSubmitNode.hidden = stage !== "review";
    setupNextNode.textContent = guideShortcutReady() || currentDetailStep() === lastDetailStep
      ? "Review plan"
      : "Continue";
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
    const firstVisible = activeSection?.querySelector<HTMLInputElement>("input:not([disabled]):not([type='hidden'])");
    firstVisible?.focus();
  };

  const validateSetupDetails = (validateAll = false): ValidationResult => {
    const { draft } = onboardingSnapshot;
    const steps = validateAll ? detailStepsForLane() : [currentDetailStep()];

    for (const step of steps) {
      if (step === "account") {
        const username = draft.account.username.trim();
        if (!username) {
          return { message: "Username is required.", step };
        }
        if (!isValidUsername(username)) {
          return { message: "Username must match ^[a-z_][a-z0-9_-]{0,31}$.", step };
        }
        if (draft.account.password.length < 8) {
          return { message: "Password must be at least 8 characters.", step };
        }
        if (draft.account.password !== draft.account.passwordConfirm) {
          return { message: "Passwords do not match.", step };
        }
      }

      if (step === "admin") {
        if (draft.admin.mode === "custom" && draft.admin.password.trim().length < 8) {
          return { message: "Admin password must be at least 8 characters.", step };
        }
      }

      if (step === "ai" && advancedSectionsVisible() && draft.ai.enabled) {
        if (!draft.ai.provider.trim()) {
          return { message: "AI provider is required when customizing AI settings.", step };
        }
        if (!draft.ai.model.trim()) {
          return { message: "AI model is required when customizing AI settings.", step };
        }
      }

      if (step === "source" && advancedSectionsVisible() && draft.source.enabled && !draft.source.value.trim()) {
        return { message: "Repository or remote URL is required for a custom system source.", step };
      }

      if (step === "device" && advancedSectionsVisible() && draft.device.enabled) {
        if (!draft.device.deviceId.trim()) {
          return { message: "Device ID is required when issuing a node token.", step };
        }
        const expiry = draft.device.expiryDays.trim();
        if (expiry && !isPositiveNumber(expiry)) {
          return { message: "Expiry must be a positive number of days.", step };
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
      return "Use gateway default AI";
    }
    const provider = draft.ai.provider.trim();
    const model = draft.ai.model.trim();
    return provider && model ? `${provider} / ${model}` : "Custom AI settings";
  };

  const buildDeviceSummary = (): string => {
    const { draft } = onboardingSnapshot;
    if (!advancedSectionsVisible() || !draft.device.enabled) {
      return "Do not issue a node token during setup";
    }
    const deviceId = draft.device.deviceId.trim();
    return deviceId ? `Issue token for ${deviceId}` : "Issue node token";
  };

  const renderReviewSummary = (): void => {
    const meta = activeLaneMeta();
    const { draft } = onboardingSnapshot;

    setupSummaryLaneNode.textContent = meta.label;
    setupSummaryLaneCopyNode.textContent = meta.reviewCopy;
    setupSummaryAccountNode.textContent = `${draft.account.username.trim()} · first desktop user`;
    setupSummaryAdminNode.textContent = draft.admin.mode === "custom"
      ? "Separate admin password"
      : "Same as account password";
    setupSummaryAiNode.textContent = buildAiSummary();
    setupSummarySourceNode.textContent = buildSourceSummary();
    setupSummaryDeviceNode.textContent = buildDeviceSummary();
  };

  const buildSetupPayload = (): SessionSetupInput => {
    const { draft } = onboardingSnapshot;
    const payload: SessionSetupInput = {
      username: draft.account.username.trim(),
      password: draft.account.password,
    };

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
    if (!result) {
      setupResultUsernameNode.textContent = snapshot.username || "Unknown";
      setupResultRootNode.textContent = adminMode === "custom" ? "Separate admin password" : "Same as account password";
      setupResultSourceNode.textContent = DEFAULT_SOURCE_LABEL;
      setupResultRefNode.textContent = DEFAULT_SOURCE_REF;
      setupNodeResultNode.hidden = true;
      setupResultNodeTokenNode.value = "";
      setupResultNodeMetaNode.textContent = "";
      return;
    }

    setupResultUsernameNode.textContent = result.user.username;
    setupResultRootNode.textContent = adminMode === "custom" ? "Separate admin password" : "Same as account password";
    setupResultSourceNode.textContent = result.bootstrap?.remoteUrl ?? DEFAULT_SOURCE_LABEL;
    setupResultRefNode.textContent = result.bootstrap?.ref ?? DEFAULT_SOURCE_REF;

    if (!result.nodeToken) {
      setupNodeResultNode.hidden = true;
      setupResultNodeTokenNode.value = "";
      setupResultNodeMetaNode.textContent = "";
      return;
    }

    const deviceId = result.nodeToken.allowedDeviceId ?? "node-id";
    const escapedDeviceId = deviceId.replaceAll("\"", "\\\"");
    const escapedToken = result.nodeToken.token.replaceAll("\"", "\\\"");
    const bootstrapCommand =
      `gsv config --local set node.id \"${escapedDeviceId}\" && ` +
      `gsv config --local set node.token \"${escapedToken}\"`;
    const expiresLabel = typeof result.nodeToken.expiresAt === "number"
      ? `Expires ${new Date(result.nodeToken.expiresAt).toLocaleString()}`
      : "No expiry";

    setupNodeResultNode.hidden = false;
    setupResultNodeLabelNode.textContent = result.nodeToken.label ?? deviceId;
    setupResultNodeTokenNode.value = bootstrapCommand;
    setupResultNodeMetaNode.textContent = `${deviceId} · ${expiresLabel}`;
  };

  const resolveVisibleView = (snapshot: SessionSnapshot): "login" | "setup" | "complete" | "desktop" => {
    if (snapshot.phase === "ready") {
      return "desktop";
    }
    if (snapshot.phase === "setup-complete") {
      return "complete";
    }
    if (snapshot.phase === "setup") {
      return "setup";
    }
    if (snapshot.phase === "authenticating") {
      if (pendingAction === "setup") {
        return "setup";
      }
      if (pendingAction === "continue") {
        return "complete";
      }
      return "login";
    }
    return "login";
  };

  const render = (): void => {
    if (statusNode) {
      statusNode.textContent = statusText(sessionSnapshot);
    }

    if (sessionSnapshot.phase === "locked" || sessionSnapshot.phase === "setup" || sessionSnapshot.phase === "setup-complete" || sessionSnapshot.phase === "ready") {
      pendingAction = null;
    }

    const visibleView = resolveVisibleView(sessionSnapshot);
    const ready = visibleView === "desktop";
    screenNode.hidden = ready;
    desktopRootNode.hidden = !ready;
    loginViewNode.hidden = visibleView !== "login";
    setupViewNode.hidden = visibleView !== "setup";
    setupCompleteNode.hidden = visibleView !== "complete";

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
      // Error is reflected through session snapshot.
    }
  };

  const onSetupContinue = async (): Promise<void> => {
    pendingAction = "continue";
    render();

    try {
      await session.continueFromSetup();
    } catch {
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

  const onLockClick = (): void => {
    session.lock();
  };

  const onGuideSend = async (): Promise<void> => {
    const message = setupGuideInputNode.value.trim();
    if (!message || onboardingSnapshot.busy) {
      return;
    }
    setupGuideInputNode.value = "";
    await onboarding.assist(message);
    focusSetupField();
  };

  const onGuideInputKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter") return;
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
  setupAdminSameNode.addEventListener("change", () => {
    if (!setupAdminSameNode.checked) return;
    updateDraft((draft) => ({
      ...draft,
      admin: {
        ...draft.admin,
        mode: "same",
      },
    }));
  });
  setupAdminCustomNode.addEventListener("change", () => {
    if (!setupAdminCustomNode.checked) return;
    updateDraft((draft) => ({
      ...draft,
      admin: {
        ...draft.admin,
        mode: "custom",
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
  setupModeManualNode.addEventListener("change", () => {
    if (!setupModeManualNode.checked) return;
    clearSetupError();
    onboarding.setMode("manual");
  });
  setupModeGuidedNode.addEventListener("change", () => {
    if (!setupModeGuidedNode.checked) return;
    clearSetupError();
    onboarding.setMode("guided");
  });
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
      setupCopyTokenNode.removeEventListener("click", onCopyToken);
      lockNode.removeEventListener("click", onLockClick);
      for (const button of setupLaneButtons) {
        button.removeEventListener("click", onSetupLaneClick);
      }
      usernameInputNode.removeEventListener("input", onLoginFieldInput);
      passwordInputNode.removeEventListener("input", onLoginFieldInput);
      tokenInputNode.removeEventListener("input", onLoginFieldInput);
      setupGuideSendNode.removeEventListener("click", onGuideSendClick);
      setupGuideInputNode.removeEventListener("keydown", onGuideInputKeyDown);
    },
  };
}
