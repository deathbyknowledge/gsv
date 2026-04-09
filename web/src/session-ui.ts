import type { SessionService, SessionSnapshot, SessionSetupInput } from "./session-service";

type SessionUiOptions = {
  rootNode: HTMLElement;
  session: SessionService;
};

type SessionUiController = {
  destroy: () => void;
};

type PendingAction = "login" | "setup" | "continue" | null;
type SetupLane = "quick" | "customize" | "advanced";
type SetupStage = "welcome" | "details" | "review";
type SetupDetailStep = "account" | "admin" | "ai" | "source" | "device";
type AdminMode = "same" | "custom";

type SetupLaneMeta = {
  label: string;
  kicker: string;
  title: string;
  description: string;
  reviewCopy: string;
};

const DEFAULT_SOURCE_LABEL = "Default upstream (deathbyknowledge/gsv#osify)";
const DEFAULT_SOURCE_REF = "osify";

const SETUP_LANE_META: Record<SetupLane, SetupLaneMeta> = {
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

  let setupLane: SetupLane | null = null;
  let setupStage: SetupStage = "welcome";
  let setupDetailStepIndex = 0;
  let pendingAction: PendingAction = null;
  let lastAdminMode: AdminMode = "same";

  const setVisibleError = (node: HTMLElement, message: string | null): void => {
    if (message) {
      node.hidden = false;
      node.textContent = message;
      return;
    }
    node.hidden = true;
    node.textContent = "";
  };

  const activeLaneMeta = (): SetupLaneMeta | null => {
    return setupLane ? SETUP_LANE_META[setupLane] : null;
  };

  const detailStepsForLane = (): SetupDetailStep[] => {
    if (setupLane === "quick") return ["account", "admin"];
    return ["account", "admin", "ai", "source", "device"];
  };

  const currentDetailStep = (): SetupDetailStep => {
    const steps = detailStepsForLane();
    const clampedIndex = Math.max(0, Math.min(setupDetailStepIndex, steps.length - 1));
    return steps[clampedIndex] ?? "account";
  };

  const applyDetailSections = (): void => {
    const activeStep = currentDetailStep();
    const showAdvanced = advancedSectionsVisible();
    for (const section of setupDetailSections) {
      const step = section.dataset.setupDetailStep as SetupDetailStep | undefined;
      const hiddenForLane = !showAdvanced && (step === "ai" || step === "source" || step === "device");
      section.hidden = setupStage !== "details" || step !== activeStep || hiddenForLane;
    }
  };

  const advancedSectionsVisible = (): boolean => {
    return setupLane === "customize" || setupLane === "advanced";
  };

  const applyLanePresentation = (): void => {
    const meta = activeLaneMeta();
    if (!meta) {
      setupHeadingNode.textContent = "Bring this gateway online";
      setupCopyNode.textContent = "Choose how much control you want, then review the exact plan before provisioning.";
      return;
    }

    setupHeadingNode.textContent = meta.label;
    setupCopyNode.textContent = meta.description;
    setupLaneKickerNode.textContent = meta.kicker;
    if (setupStage === "details") {
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
      button.classList.toggle("is-selected", button.dataset.setupLane === setupLane);
    }
  };

  const syncOptionalSetupFields = (): void => {
    const customAdmin = setupAdminCustomNode.checked;
    const showAdvanced = advancedSectionsVisible();
    const showAiRows = showAdvanced && setupAiEnabledNode.checked;
    const showSourceRows = showAdvanced && setupSourceEnabledNode.checked;
    const showNodeRows = showAdvanced && setupNodeEnabledNode.checked;

    setupRootRowNode.hidden = !customAdmin;
    setupRootPasswordNode.disabled = !customAdmin;

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

  const applySetupStage = (): void => {
    setupWelcomeNode.hidden = setupStage !== "welcome";
    setupDetailsNode.hidden = setupStage !== "details";
    setupReviewNode.hidden = setupStage !== "review";
    applyDetailSections();

    for (const pill of setupStagePills) {
      const pillStage = pill.dataset.setupStagePill as SetupStage | undefined;
      pill.classList.toggle("is-active", pillStage === setupStage);
      pill.classList.toggle(
        "is-complete",
        (setupStage === "details" && pillStage === "welcome") ||
          (setupStage === "review" && (pillStage === "welcome" || pillStage === "details")),
      );
    }

    setupBackNode.hidden = setupStage === "welcome";
    setupNextNode.hidden = setupStage !== "details";
    setupSubmitNode.hidden = setupStage !== "review";
    setupNextNode.textContent = setupDetailStepIndex >= detailStepsForLane().length - 1 ? "Review plan" : "Continue";
  };

  const focusLoginField = (): void => {
    if (!usernameInputNode.value.trim()) {
      usernameInputNode.focus();
      return;
    }
    passwordInputNode.focus();
  };

  const focusSetupField = (): void => {
    if (setupStage === "welcome") {
      setupLaneButtons[0]?.focus();
      return;
    }
    if (setupStage === "review") {
      setupSubmitNode.focus();
      return;
    }
    const activeSection = setupDetailSections.find((section) => !section.hidden);
    const firstVisible = activeSection?.querySelector<HTMLInputElement>("input:not([disabled]):not([type='hidden'])");
    firstVisible?.focus();
  };

  const validateSetupDetails = (validateAll = false): string | null => {
    const username = setupUsernameNode.value.trim();
    const password = setupPasswordNode.value;
    const confirm = setupPasswordConfirmNode.value;
    const detailStep = currentDetailStep();

    if (!setupLane) {
      return "Choose a setup path first.";
    }
    if (validateAll || detailStep === "account") {
      if (!username) {
        return "Username is required.";
      }
      if (!isValidUsername(username)) {
        return "Username must match ^[a-z_][a-z0-9_-]{0,31}$.";
      }
      if (password.length < 8) {
        return "Password must be at least 8 characters.";
      }
      if (password !== confirm) {
        return "Passwords do not match.";
      }
    }

    if (validateAll || detailStep === "admin") {
      if (setupAdminCustomNode.checked && setupRootPasswordNode.value.trim().length < 8) {
        return "Admin password must be at least 8 characters.";
      }
    }

    if ((validateAll || detailStep === "ai") && advancedSectionsVisible()) {
      if (setupAiEnabledNode.checked) {
        if (!setupAiProviderNode.value.trim()) {
          return "AI provider is required when customizing AI settings.";
        }
        if (!setupAiModelNode.value.trim()) {
          return "AI model is required when customizing AI settings.";
        }
      }
    }

    if ((validateAll || detailStep === "source") && advancedSectionsVisible()) {
      if (setupSourceEnabledNode.checked && !setupBootstrapSourceNode.value.trim()) {
        return "Repository or remote URL is required for a custom system source.";
      }
    }

    if ((validateAll || detailStep === "device") && advancedSectionsVisible() && setupNodeEnabledNode.checked) {
      if (!setupNodeDeviceIdNode.value.trim()) {
        return "Device ID is required when issuing a node token.";
      }
      const expiry = setupNodeExpiryNode.value.trim();
      if (expiry && !isPositiveNumber(expiry)) {
        return "Expiry must be a positive number of days.";
      }
    }

    return null;
  };

  const buildSourceSummary = (): string => {
    if (!advancedSectionsVisible() || !setupSourceEnabledNode.checked) {
      return DEFAULT_SOURCE_LABEL;
    }
    const source = setupBootstrapSourceNode.value.trim();
    const ref = setupBootstrapRefNode.value.trim();
    if (!source) {
      return DEFAULT_SOURCE_LABEL;
    }
    return ref ? `${source}#${ref}` : source;
  };

  const buildAiSummary = (): string => {
    if (!advancedSectionsVisible() || !setupAiEnabledNode.checked) {
      return "Use gateway default AI";
    }
    const provider = setupAiProviderNode.value.trim();
    const model = setupAiModelNode.value.trim();
    return provider && model ? `${provider} / ${model}` : "Custom AI settings";
  };

  const buildDeviceSummary = (): string => {
    if (!advancedSectionsVisible() || !setupNodeEnabledNode.checked) {
      return "Do not issue a node token during setup";
    }
    const deviceId = setupNodeDeviceIdNode.value.trim();
    return deviceId ? `Issue token for ${deviceId}` : "Issue node token";
  };

  const renderReviewSummary = (): void => {
    const meta = activeLaneMeta();
    if (!meta) return;

    setupSummaryLaneNode.textContent = meta.label;
    setupSummaryLaneCopyNode.textContent = meta.reviewCopy;
    setupSummaryAccountNode.textContent = `${setupUsernameNode.value.trim()} · first desktop user`;
    setupSummaryAdminNode.textContent = setupAdminCustomNode.checked
      ? "Separate admin password"
      : "Same as account password";
    setupSummaryAiNode.textContent = buildAiSummary();
    setupSummarySourceNode.textContent = buildSourceSummary();
    setupSummaryDeviceNode.textContent = buildDeviceSummary();
  };

  const buildSetupPayload = (): SessionSetupInput => {
    const payload: SessionSetupInput = {
      username: setupUsernameNode.value.trim(),
      password: setupPasswordNode.value,
    };

    if (setupAdminCustomNode.checked && setupRootPasswordNode.value.trim()) {
      payload.rootPassword = setupRootPasswordNode.value.trim();
    }

    if (advancedSectionsVisible() && setupAiEnabledNode.checked) {
      payload.ai = {
        provider: setupAiProviderNode.value.trim(),
        model: setupAiModelNode.value.trim(),
        ...(setupAiKeyNode.value.trim() ? { apiKey: setupAiKeyNode.value.trim() } : {}),
      };
    }

    if (advancedSectionsVisible() && setupSourceEnabledNode.checked) {
      const source = setupBootstrapSourceNode.value.trim();
      const ref = setupBootstrapRefNode.value.trim();
      payload.bootstrap = sourceLooksLikeRemote(source)
        ? { remoteUrl: source }
        : { repo: source };
      if (ref) {
        payload.bootstrap.ref = ref;
      }
    }

    if (advancedSectionsVisible() && setupNodeEnabledNode.checked) {
      const expiryDays = setupNodeExpiryNode.value.trim();
      payload.node = {
        deviceId: setupNodeDeviceIdNode.value.trim(),
        ...(setupNodeLabelNode.value.trim() ? { label: setupNodeLabelNode.value.trim() } : {}),
        ...(expiryDays
          ? { expiresAt: Date.now() + Math.floor(Number(expiryDays) * 24 * 60 * 60 * 1000) }
          : {}),
      };
    }

    return payload;
  };

  const renderSetupResult = (snapshot: SessionSnapshot): void => {
    const result = snapshot.setupResult;
    if (!result) {
      setupResultUsernameNode.textContent = snapshot.username || "Unknown";
      setupResultRootNode.textContent = lastAdminMode === "custom" ? "Separate admin password" : "Same as account password";
      setupResultSourceNode.textContent = DEFAULT_SOURCE_LABEL;
      setupResultRefNode.textContent = DEFAULT_SOURCE_REF;
      setupNodeResultNode.hidden = true;
      setupResultNodeTokenNode.value = "";
      setupResultNodeMetaNode.textContent = "";
      return;
    }

    setupResultUsernameNode.textContent = result.user.username;
    setupResultRootNode.textContent = lastAdminMode === "custom" ? "Separate admin password" : "Same as account password";
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

  const applySnapshot = (snapshot: SessionSnapshot): void => {
    if (statusNode) {
      statusNode.textContent = statusText(snapshot);
    }

    if (snapshot.phase === "locked" || snapshot.phase === "setup" || snapshot.phase === "setup-complete" || snapshot.phase === "ready") {
      pendingAction = null;
    }

    const visibleView = resolveVisibleView(snapshot);
    const ready = visibleView === "desktop";
    screenNode.hidden = ready;
    desktopRootNode.hidden = !ready;
    loginViewNode.hidden = visibleView !== "login";
    setupViewNode.hidden = visibleView !== "setup";
    setupCompleteNode.hidden = visibleView !== "complete";

    submitNode.disabled = snapshot.phase === "authenticating";
    setupBackNode.disabled = snapshot.phase === "authenticating";
    setupNextNode.disabled = snapshot.phase === "authenticating";
    setupSubmitNode.disabled = snapshot.phase === "authenticating";
    setupContinueNode.disabled = snapshot.phase === "authenticating";
    lockNode.disabled = snapshot.phase !== "ready";

    dotNode.classList.toggle("is-online", snapshot.phase === "ready");
    dotNode.classList.toggle("is-pending", snapshot.phase === "authenticating");
    dotNode.classList.toggle("is-offline", snapshot.phase !== "ready" && snapshot.phase !== "authenticating");

    setVisibleError(
      loginErrorNode,
      snapshot.phase === "locked" && snapshot.message ? snapshot.message : null,
    );
    setVisibleError(
      setupErrorNode,
      snapshot.phase === "setup" && snapshot.message ? snapshot.message : null,
    );
    setVisibleError(
      setupCompleteErrorNode,
      snapshot.phase === "setup-complete" && snapshot.message ? snapshot.message : null,
    );

    if (snapshot.phase === "ready") {
      passwordInputNode.value = "";
      tokenInputNode.value = "";
      return;
    }

    if (snapshot.username && !usernameInputNode.value) {
      usernameInputNode.value = snapshot.username;
    }
    if (snapshot.username && !setupUsernameNode.value) {
      setupUsernameNode.value = snapshot.username;
    }

    applyLanePresentation();
    syncOptionalSetupFields();
    applySetupStage();

    if (visibleView === "login") {
      focusLoginField();
      return;
    }
    if (visibleView === "setup") {
      focusSetupField();
      return;
    }
    if (visibleView === "complete") {
      renderSetupResult(snapshot);
      setupContinueNode.focus();
    }
  };

  const onLoginSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();

    const username = usernameInputNode.value.trim();
    const password = passwordInputNode.value.trim();
    const token = tokenInputNode.value.trim();

    if (!username) {
      setVisibleError(loginErrorNode, "Username is required.");
      return;
    }
    if (!password && !token) {
      setVisibleError(loginErrorNode, "Provide password or token.");
      return;
    }
    if (password && token) {
      setVisibleError(loginErrorNode, "Use either password or token.");
      return;
    }

    pendingAction = "login";

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
    const nextLane = target.dataset.setupLane as SetupLane | undefined;
    if (!nextLane) return;
    setupLane = nextLane;
    setupDetailStepIndex = 0;
    setVisibleError(setupErrorNode, null);
    applyLanePresentation();
    syncOptionalSetupFields();
    setupStage = "details";
    applySetupStage();
    focusSetupField();
  };

  const onSetupBackClick = (): void => {
    setVisibleError(setupErrorNode, null);
    if (setupStage === "review") {
      setupStage = "details";
    } else if (setupDetailStepIndex > 0) {
      setupDetailStepIndex -= 1;
    } else {
      setupStage = "welcome";
    }
    applyLanePresentation();
    applySetupStage();
    focusSetupField();
  };

  const onSetupNextClick = (): void => {
    const error = validateSetupDetails();
    if (error) {
      setVisibleError(setupErrorNode, error);
      return;
    }
    setVisibleError(setupErrorNode, null);
    if (setupDetailStepIndex < detailStepsForLane().length - 1) {
      setupDetailStepIndex += 1;
      applyLanePresentation();
    } else {
      renderReviewSummary();
      setupStage = "review";
    }
    applySetupStage();
    focusSetupField();
  };

  const onSetupSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();

    const error = validateSetupDetails(true);
    if (error) {
      setVisibleError(setupErrorNode, error);
      setupStage = "details";
      applySetupStage();
      focusSetupField();
      return;
    }

    if (setupStage !== "review") {
      renderReviewSummary();
      setupStage = "review";
      applySetupStage();
      return;
    }

    pendingAction = "setup";
    lastAdminMode = setupAdminCustomNode.checked ? "custom" : "same";

    try {
      await session.setup(buildSetupPayload());
    } catch {
      // Error is reflected through session snapshot.
    }
  };

  const onSetupContinue = async (): Promise<void> => {
    pendingAction = "continue";

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
  setupAdminSameNode.addEventListener("change", syncOptionalSetupFields);
  setupAdminCustomNode.addEventListener("change", syncOptionalSetupFields);
  setupAiEnabledNode.addEventListener("change", syncOptionalSetupFields);
  setupSourceEnabledNode.addEventListener("change", syncOptionalSetupFields);
  setupNodeEnabledNode.addEventListener("change", syncOptionalSetupFields);

  const unsubscribe = session.subscribe((snapshot) => {
    applySnapshot(snapshot);
  });

  return {
    destroy: () => {
      unsubscribe();
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
      setupAdminSameNode.removeEventListener("change", syncOptionalSetupFields);
      setupAdminCustomNode.removeEventListener("change", syncOptionalSetupFields);
      setupAiEnabledNode.removeEventListener("change", syncOptionalSetupFields);
      setupSourceEnabledNode.removeEventListener("change", syncOptionalSetupFields);
      setupNodeEnabledNode.removeEventListener("change", syncOptionalSetupFields);
    },
  };
}
