import type { SessionService, SessionSnapshot, SessionSetupInput } from "./session-service";

type SessionUiOptions = {
  rootNode: HTMLElement;
  session: SessionService;
};

type SessionUiController = {
  destroy: () => void;
};

type PendingAction = "login" | "setup" | "continue" | "bootstrap" | null;

function statusText(snapshot: SessionSnapshot): string {
  switch (snapshot.phase) {
    case "ready":
      return "session: connected";
    case "setup":
      return "session: setup required";
    case "setup-complete":
      return "session: ready";
    case "authenticating":
      return "session: authenticating...";
    default:
      return "session: locked";
  }
}

function isValidUsername(value: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(value);
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
  const setupSteps = Array.from(rootNode.querySelectorAll<HTMLElement>("[data-setup-step]"));
  const setupProgressLabelNode = rootNode.querySelector<HTMLElement>("[data-setup-progress-label]");
  const setupProgressFillNode = rootNode.querySelector<HTMLElement>("[data-setup-progress-fill]");
  const setupBackNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-back]");
  const setupNextNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-next]");
  const setupSubmitNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-submit]");
  const setupUsernameNode = rootNode.querySelector<HTMLInputElement>("[data-setup-username]");
  const setupPasswordNode = rootNode.querySelector<HTMLInputElement>("[data-setup-password]");
  const setupPasswordConfirmNode = rootNode.querySelector<HTMLInputElement>("[data-setup-password-confirm]");
  const setupRootEnabledNode = rootNode.querySelector<HTMLInputElement>("[data-setup-root-enabled]");
  const setupRootRowNode = rootNode.querySelector<HTMLElement>("[data-setup-root-row]");
  const setupRootPasswordNode = rootNode.querySelector<HTMLInputElement>("[data-setup-root-password]");
  const setupAiEnabledNode = rootNode.querySelector<HTMLInputElement>("[data-setup-ai-enabled]");
  const setupAiProviderRowNode = rootNode.querySelector<HTMLElement>("[data-setup-ai-provider-row]");
  const setupAiModelRowNode = rootNode.querySelector<HTMLElement>("[data-setup-ai-model-row]");
  const setupAiKeyRowNode = rootNode.querySelector<HTMLElement>("[data-setup-ai-key-row]");
  const setupAiProviderNode = rootNode.querySelector<HTMLInputElement>("[data-setup-ai-provider]");
  const setupAiModelNode = rootNode.querySelector<HTMLInputElement>("[data-setup-ai-model]");
  const setupAiKeyNode = rootNode.querySelector<HTMLInputElement>("[data-setup-ai-key]");
  const setupNodeEnabledNode = rootNode.querySelector<HTMLInputElement>("[data-setup-node-enabled]");
  const setupNodeDeviceRowNode = rootNode.querySelector<HTMLElement>("[data-setup-node-device-row]");
  const setupNodeLabelRowNode = rootNode.querySelector<HTMLElement>("[data-setup-node-label-row]");
  const setupNodeExpiryRowNode = rootNode.querySelector<HTMLElement>("[data-setup-node-expiry-row]");
  const setupNodeDeviceIdNode = rootNode.querySelector<HTMLInputElement>("[data-setup-node-device-id]");
  const setupNodeLabelNode = rootNode.querySelector<HTMLInputElement>("[data-setup-node-label]");
  const setupNodeExpiryNode = rootNode.querySelector<HTMLInputElement>("[data-setup-node-expiry]");
  const setupContinueNode = rootNode.querySelector<HTMLButtonElement>("[data-session-setup-continue]");
  const setupBootstrapNode = rootNode.querySelector<HTMLButtonElement>("[data-session-setup-bootstrap]");
  const setupBootstrapStatusNode = rootNode.querySelector<HTMLElement>("[data-session-setup-bootstrap-status]");
  const setupBootstrapSourceNode = rootNode.querySelector<HTMLInputElement>("[data-setup-bootstrap-source]");
  const setupBootstrapRefNode = rootNode.querySelector<HTMLInputElement>("[data-setup-bootstrap-ref]");
  const setupCopyTokenNode = rootNode.querySelector<HTMLButtonElement>("[data-setup-copy-token]");
  const setupCompleteErrorNode = rootNode.querySelector<HTMLElement>("[data-session-setup-complete-error]");
  const setupResultUsernameNode = rootNode.querySelector<HTMLElement>("[data-setup-result-username]");
  const setupResultRootNode = rootNode.querySelector<HTMLElement>("[data-setup-result-root]");
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
    setupSteps.length === 0 ||
    !setupProgressLabelNode ||
    !setupProgressFillNode ||
    !setupBackNode ||
    !setupNextNode ||
    !setupSubmitNode ||
    !setupUsernameNode ||
    !setupPasswordNode ||
    !setupPasswordConfirmNode ||
    !setupRootEnabledNode ||
    !setupRootRowNode ||
    !setupRootPasswordNode ||
    !setupAiEnabledNode ||
    !setupAiProviderRowNode ||
    !setupAiModelRowNode ||
    !setupAiKeyRowNode ||
    !setupAiProviderNode ||
    !setupAiModelNode ||
    !setupAiKeyNode ||
    !setupNodeEnabledNode ||
    !setupNodeDeviceRowNode ||
    !setupNodeLabelRowNode ||
    !setupNodeExpiryRowNode ||
    !setupNodeDeviceIdNode ||
    !setupNodeLabelNode ||
    !setupNodeExpiryNode ||
    !setupContinueNode ||
    !setupBootstrapNode ||
    !setupBootstrapStatusNode ||
    !setupBootstrapSourceNode ||
    !setupBootstrapRefNode ||
    !setupCopyTokenNode ||
    !setupCompleteErrorNode ||
    !setupResultUsernameNode ||
    !setupResultRootNode ||
    !setupNodeResultNode ||
    !setupResultNodeLabelNode ||
    !setupResultNodeTokenNode ||
    !setupResultNodeMetaNode
  ) {
    throw new Error("Session UI markup is incomplete");
  }

  let setupStepIndex = 0;
  let pendingAction: PendingAction = null;

  const setVisibleError = (node: HTMLElement, message: string | null): void => {
    if (message) {
      node.hidden = false;
      node.textContent = message;
      return;
    }
    node.hidden = true;
    node.textContent = "";
  };

  const syncOptionalSetupFields = (): void => {
    setupRootRowNode.hidden = !setupRootEnabledNode.checked;
    setupAiProviderRowNode.hidden = !setupAiEnabledNode.checked;
    setupAiModelRowNode.hidden = !setupAiEnabledNode.checked;
    setupAiKeyRowNode.hidden = !setupAiEnabledNode.checked;
    setupNodeDeviceRowNode.hidden = !setupNodeEnabledNode.checked;
    setupNodeLabelRowNode.hidden = !setupNodeEnabledNode.checked;
    setupNodeExpiryRowNode.hidden = !setupNodeEnabledNode.checked;
    setupRootPasswordNode.disabled = !setupRootEnabledNode.checked;
    setupAiProviderNode.disabled = !setupAiEnabledNode.checked;
    setupAiModelNode.disabled = !setupAiEnabledNode.checked;
    setupAiKeyNode.disabled = !setupAiEnabledNode.checked;
    setupNodeDeviceIdNode.disabled = !setupNodeEnabledNode.checked;
    setupNodeLabelNode.disabled = !setupNodeEnabledNode.checked;
    setupNodeExpiryNode.disabled = !setupNodeEnabledNode.checked;
  };

  const applySetupStep = (): void => {
    setupSteps.forEach((node, index) => {
      node.hidden = index !== setupStepIndex;
    });

    setupBackNode.hidden = setupStepIndex === 0;
    setupNextNode.hidden = setupStepIndex === setupSteps.length - 1;
    setupSubmitNode.hidden = setupStepIndex !== setupSteps.length - 1;
    setupProgressLabelNode.textContent = `Step ${setupStepIndex + 1} of ${setupSteps.length}`;
    setupProgressFillNode.style.width = `${((setupStepIndex + 1) / setupSteps.length) * 100}%`;
  };

  const focusLoginField = (): void => {
    if (!usernameInputNode.value.trim()) {
      usernameInputNode.focus();
      return;
    }
    passwordInputNode.focus();
  };

  const focusSetupField = (): void => {
    const activeStep = setupSteps[setupStepIndex];
    const focusTarget = activeStep.querySelector<HTMLInputElement>("input:not([hidden])");
    focusTarget?.focus();
  };

  const validateSetupStep = (): string | null => {
    switch (setupStepIndex) {
      case 0: {
        const username = setupUsernameNode.value.trim();
        const password = setupPasswordNode.value;
        const confirm = setupPasswordConfirmNode.value;
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
        return null;
      }
      case 1:
        if (setupRootEnabledNode.checked && setupRootPasswordNode.value.trim().length < 8) {
          return "Root password must be at least 8 characters.";
        }
        return null;
      case 3: {
        if (!setupNodeEnabledNode.checked) {
          return null;
        }
        if (!setupNodeDeviceIdNode.value.trim()) {
          return "Device ID is required when issuing a node token.";
        }
        const days = setupNodeExpiryNode.value.trim();
        if (days && (!Number.isFinite(Number(days)) || Number(days) <= 0)) {
          return "Expiry must be a positive number of days.";
        }
        return null;
      }
      default:
        return null;
    }
  };

  const buildSetupPayload = (): SessionSetupInput => {
    const payload: SessionSetupInput = {
      username: setupUsernameNode.value.trim(),
      password: setupPasswordNode.value,
    };

    if (setupRootEnabledNode.checked && setupRootPasswordNode.value.trim()) {
      payload.rootPassword = setupRootPasswordNode.value.trim();
    }

    if (setupAiEnabledNode.checked) {
      const aiProvider = setupAiProviderNode.value.trim();
      const aiModel = setupAiModelNode.value.trim();
      const aiKey = setupAiKeyNode.value.trim();
      if (aiProvider || aiModel || aiKey) {
        payload.ai = {
          ...(aiProvider ? { provider: aiProvider } : {}),
          ...(aiModel ? { model: aiModel } : {}),
          ...(aiKey ? { apiKey: aiKey } : {}),
        };
      }
    }

    if (setupNodeEnabledNode.checked) {
      const deviceId = setupNodeDeviceIdNode.value.trim();
      const label = setupNodeLabelNode.value.trim();
      const expiryDays = setupNodeExpiryNode.value.trim();
      payload.node = {
        deviceId,
        ...(label ? { label } : {}),
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
      setupResultRootNode.textContent = "Locked";
      setupNodeResultNode.hidden = true;
      setupResultNodeTokenNode.value = "";
      setupResultNodeMetaNode.textContent = "";
      return;
    }

    setupResultUsernameNode.textContent = result.user.username;
    setupResultRootNode.textContent = result.rootLocked ? "Locked" : "Configured";

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
      `gsv config --local set node.id "${escapedDeviceId}" && ` +
      `gsv config --local set node.token "${escapedToken}"`;
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
      if (pendingAction === "bootstrap") {
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
    setupBootstrapNode.disabled = snapshot.phase === "authenticating";
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

    syncOptionalSetupFields();
    applySetupStep();

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

  const onSetupBackClick = (): void => {
    setupStepIndex = Math.max(0, setupStepIndex - 1);
    setVisibleError(setupErrorNode, null);
    applySetupStep();
    focusSetupField();
  };

  const onSetupNextClick = (): void => {
    const error = validateSetupStep();
    if (error) {
      setVisibleError(setupErrorNode, error);
      return;
    }
    setVisibleError(setupErrorNode, null);
    setupStepIndex = Math.min(setupSteps.length - 1, setupStepIndex + 1);
    applySetupStep();
    focusSetupField();
  };

  const onSetupSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();

    const error = validateSetupStep();
    if (error) {
      setVisibleError(setupErrorNode, error);
      return;
    }

    pendingAction = "setup";

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

  const onSetupBootstrap = async (): Promise<void> => {
    pendingAction = "bootstrap";
    setupBootstrapStatusNode.hidden = false;
    setupBootstrapNode.disabled = true;
    setupContinueNode.disabled = true;

    try {
      const source = setupBootstrapSourceNode.value.trim();
      const ref = setupBootstrapRefNode.value.trim();
      await session.initializeFromUpstream(
        source || ref
          ? {
              ...(source
                ? source.includes("://") || source.startsWith("git@")
                  ? { remoteUrl: source }
                  : { repo: source }
                : {}),
              ...(ref ? { ref } : {}),
            }
          : undefined,
      );
    } catch {
      pendingAction = null;
      setupBootstrapStatusNode.hidden = true;
      setupBootstrapNode.disabled = false;
      setupContinueNode.disabled = false;
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
  setupBootstrapNode.addEventListener("click", onSetupBootstrap);
  setupCopyTokenNode.addEventListener("click", onCopyToken);
  lockNode.addEventListener("click", onLockClick);
  setupRootEnabledNode.addEventListener("change", syncOptionalSetupFields);
  setupAiEnabledNode.addEventListener("change", syncOptionalSetupFields);
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
      setupBootstrapNode.removeEventListener("click", onSetupBootstrap);
      setupCopyTokenNode.removeEventListener("click", onCopyToken);
      lockNode.removeEventListener("click", onLockClick);
      setupRootEnabledNode.removeEventListener("change", syncOptionalSetupFields);
      setupAiEnabledNode.removeEventListener("change", syncOptionalSetupFields);
      setupNodeEnabledNode.removeEventListener("change", syncOptionalSetupFields);
    },
  };
}
