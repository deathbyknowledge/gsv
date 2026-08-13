import type { OnboardingDraft } from "@humansandmachines/gsv/protocol";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AI_PROVIDER_OPTIONS } from "../../../domain/aiProviders";
import type {
  SessionService,
  SessionSnapshot,
} from "../../../services/session/sessionService";
import {
  buildAiSummary,
  buildDeviceSummary,
  currentDetailStep,
  provisioningCopy,
} from "../../session/sessionDomain";
import { useSessionScreensState } from "../../session/useSessionScreensState";
import "./textSessionScreens.css";

export type TextSessionScreensProps = {
  session: SessionService;
  snapshot: SessionSnapshot;
};

type LoginStep = "username" | "credential";
type CredentialKind = "password" | "token";
type InputType = "text" | "password";

type InputScene = {
  key: string;
  eyebrow: string;
  question: string;
  value: string;
  placeholder?: string;
  type?: InputType;
  autoComplete: string;
  inputMode?: "text" | "numeric";
  list?: string;
  optional?: boolean;
  onValue: (value: string) => void;
};

type ChoiceScene = {
  key: "admin" | "ai" | "device";
  eyebrow: string;
  question: string;
  value: string | boolean;
  choices: Array<{
    label: string;
    value: string | boolean;
    choose: () => void;
  }>;
};

type SystemScene = InputScene | ChoiceScene;

function isChoiceScene(scene: SystemScene): scene is ChoiceScene {
  return "choices" in scene;
}

function ProgressMarkers({ count, current }: { count: number; current: number }) {
  return (
    <span class="text-session-progress" aria-label={`Step ${Math.min(current + 1, count)} of ${count}`}>
      {Array.from({ length: count }, (_, index) => (
        <span
          class={`text-session-progress-mark${index === current ? " is-current" : ""}${index < current ? " is-complete" : ""}`}
          key={index}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

function updateAccount(
  draft: OnboardingDraft,
  patch: Partial<OnboardingDraft["account"]>,
): OnboardingDraft {
  return {
    ...draft,
    account: {
      ...draft.account,
      ...patch,
    },
  };
}

function NativeInput({
  scene,
  inputRef,
  dataAttribute,
  disabled = false,
}: {
  scene: InputScene;
  inputRef: { current: HTMLInputElement | null };
  dataAttribute?: "username" | "password";
  disabled?: boolean;
}) {
  return (
    <input
      ref={inputRef}
      id={scene.key}
      class="text-session-input"
      type={scene.type ?? "text"}
      name={scene.key}
      value={scene.value}
      placeholder={scene.placeholder}
      autoComplete={scene.autoComplete}
      inputMode={scene.inputMode}
      list={scene.list}
      autoCapitalize="none"
      spellcheck={false}
      disabled={disabled}
      aria-label={scene.question}
      data-session-username={dataAttribute === "username" ? true : undefined}
      data-session-password={dataAttribute === "password" ? true : undefined}
      onInput={(event) => scene.onValue(event.currentTarget.value)}
    />
  );
}

export function TextSessionScreens({ session, snapshot }: TextSessionScreensProps) {
  const state = useSessionScreensState({ session, snapshot });
  const { draft } = state.onboardingSnapshot;
  const [loginStep, setLoginStep] = useState<LoginStep>(() => (
    snapshot.username.trim() ? "credential" : "username"
  ));
  const [credentialKind, setCredentialKind] = useState<CredentialKind>("password");
  const [localLoginError, setLocalLoginError] = useState<string | null>(null);
  const [setupField, setSetupField] = useState(0);
  const [finishSystemRequested, setFinishSystemRequested] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const visibleView = state.visibleView;
  const detailStep = currentDetailStep(draft);

  const accountScenes: InputScene[] = [
    {
      key: "setup-username",
      eyebrow: "CREATE · 01 / 03",
      question: "What should we call you?",
      value: draft.account.username,
      placeholder: "operator",
      autoComplete: "username",
      onValue: (value) => state.setup.updateDraft((current) => (
        updateAccount(current, { username: value.toLowerCase() })
      )),
    },
    {
      key: "setup-agent",
      eyebrow: "CREATE · 01 / 03",
      question: "Name your personal agent.",
      value: draft.account.agentName,
      placeholder: "optional",
      autoComplete: "off",
      optional: true,
      onValue: (value) => state.setup.updateDraft((current) => (
        updateAccount(current, { agentName: value.toLowerCase() })
      )),
    },
    {
      key: "setup-password",
      eyebrow: "CREATE · 01 / 03",
      question: "Choose a password.",
      value: draft.account.password,
      placeholder: "at least eight characters",
      type: "password",
      autoComplete: "new-password",
      onValue: (value) => state.setup.updateDraft((current) => (
        updateAccount(current, { password: value })
      )),
    },
    {
      key: "setup-password-confirm",
      eyebrow: "CREATE · 01 / 03",
      question: "Once more.",
      value: draft.account.passwordConfirm,
      placeholder: "repeat your password",
      type: "password",
      autoComplete: "new-password",
      onValue: (value) => state.setup.updateDraft((current) => (
        updateAccount(current, { passwordConfirm: value })
      )),
    },
  ];

  const systemScenes = useMemo<SystemScene[]>(() => {
    const scenes: SystemScene[] = [
      {
        key: "setup-timezone",
        eyebrow: "CREATE · 02 / 03",
        question: "Where are you?",
        value: draft.system.timezone,
        placeholder: "Europe/Amsterdam",
        autoComplete: "off",
        list: "text-session-timezones",
        onValue: (value) => state.setup.updateDraft((current) => ({
          ...current,
          system: { ...current.system, timezone: value },
        })),
      },
    ];

    if (draft.lane === "quick") {
      return scenes;
    }

    scenes.push({
      key: "admin",
      eyebrow: "CREATE · 02 / 03",
      question: "Protect admin work separately?",
      value: draft.admin.mode,
      choices: [
        {
          label: "Use my account password",
          value: "same",
          choose: () => state.setup.updateDraft((current) => ({
            ...current,
            admin: { ...current.admin, mode: "same" },
          })),
        },
        {
          label: "Use a separate password",
          value: "custom",
          choose: () => state.setup.updateDraft((current) => ({
            ...current,
            admin: { ...current.admin, mode: "custom" },
          })),
        },
      ],
    });

    if (draft.admin.mode === "custom") {
      scenes.push(
        {
          key: "setup-admin-password",
          eyebrow: "CREATE · 02 / 03",
          question: "Choose the admin password.",
          value: draft.admin.password,
          type: "password",
          autoComplete: "new-password",
          onValue: (value) => state.setup.updateDraft((current) => ({
            ...current,
            admin: { ...current.admin, password: value },
          })),
        },
        {
          key: "setup-admin-password-confirm",
          eyebrow: "CREATE · 02 / 03",
          question: "Repeat the admin password.",
          value: draft.admin.passwordConfirm,
          type: "password",
          autoComplete: "new-password",
          onValue: (value) => state.setup.updateDraft((current) => ({
            ...current,
            admin: { ...current.admin, passwordConfirm: value },
          })),
        },
      );
    }

    scenes.push({
      key: "ai",
      eyebrow: "CREATE · 02 / 03",
      question: "Customize the default intelligence?",
      value: draft.ai.enabled,
      choices: [
        {
          label: "Use the defaults",
          value: false,
          choose: () => state.setup.updateDraft((current) => ({
            ...current,
            ai: { ...current.ai, enabled: false },
          })),
        },
        {
          label: "Choose it now",
          value: true,
          choose: () => state.setup.updateDraft((current) => ({
            ...current,
            ai: {
              ...current.ai,
              enabled: true,
              provider: current.ai.provider || AI_PROVIDER_OPTIONS[0]?.value || "workers-ai",
            },
          })),
        },
      ],
    });

    if (draft.ai.enabled) {
      scenes.push(
        {
          key: "setup-ai-provider",
          eyebrow: "CREATE · 02 / 03",
          question: "Which AI service?",
          value: draft.ai.provider,
          placeholder: "openai",
          autoComplete: "off",
          list: "text-session-ai-providers",
          onValue: (value) => state.setup.updateDraft((current) => ({
            ...current,
            ai: { ...current.ai, provider: value },
          })),
        },
        {
          key: "setup-ai-model",
          eyebrow: "CREATE · 02 / 03",
          question: "Which model?",
          value: draft.ai.model,
          placeholder: "model name",
          autoComplete: "off",
          onValue: (value) => state.setup.updateDraft((current) => ({
            ...current,
            ai: { ...current.ai, model: value },
          })),
        },
        {
          key: "setup-ai-key",
          eyebrow: "CREATE · 02 / 03",
          question: "API key, if it needs one.",
          value: draft.ai.apiKey,
          placeholder: "optional",
          type: "password",
          autoComplete: "off",
          optional: true,
          onValue: (value) => state.setup.updateDraft((current) => ({
            ...current,
            ai: { ...current.ai, apiKey: value },
          })),
        },
      );
    }

    scenes.push({
      key: "device",
      eyebrow: "CREATE · 02 / 03",
      question: "Connect another machine now?",
      value: draft.device.enabled,
      choices: [
        {
          label: "Not now",
          value: false,
          choose: () => state.setup.updateDraft((current) => ({
            ...current,
            device: { ...current.device, enabled: false },
          })),
        },
        {
          label: "Create a setup key",
          value: true,
          choose: () => state.setup.updateDraft((current) => ({
            ...current,
            device: { ...current.device, enabled: true },
          })),
        },
      ],
    });

    if (draft.device.enabled) {
      scenes.push(
        {
          key: "setup-device-id",
          eyebrow: "CREATE · 02 / 03",
          question: "Name the device.",
          value: draft.device.deviceId,
          placeholder: "node-studio",
          autoComplete: "off",
          onValue: (value) => state.setup.updateDraft((current) => ({
            ...current,
            device: { ...current.device, deviceId: value },
          })),
        },
        {
          key: "setup-device-label",
          eyebrow: "CREATE · 02 / 03",
          question: "A short label.",
          value: draft.device.label,
          placeholder: "optional",
          autoComplete: "off",
          optional: true,
          onValue: (value) => state.setup.updateDraft((current) => ({
            ...current,
            device: { ...current.device, label: value },
          })),
        },
        {
          key: "setup-device-expiry",
          eyebrow: "CREATE · 02 / 03",
          question: "How many days should the key last?",
          value: draft.device.expiryDays,
          placeholder: "no expiry",
          autoComplete: "off",
          inputMode: "numeric",
          optional: true,
          onValue: (value) => state.setup.updateDraft((current) => ({
            ...current,
            device: { ...current.device, expiryDays: value },
          })),
        },
      );
    }

    return scenes;
  }, [draft, state.setup]);

  const accountIndex = Math.min(setupField, accountScenes.length - 1);
  const systemIndex = Math.min(setupField, Math.max(0, systemScenes.length - 1));
  const activeAccountScene = accountScenes[accountIndex]!;
  const activeSystemScene = systemScenes[systemIndex]!;
  const sceneKey = visibleView === "login"
    ? `${visibleView}:${state.busy ? "busy" : loginStep}:${credentialKind}`
    : visibleView === "setup"
      ? `${visibleView}:${draft.stage}:${detailStep}:${setupField}`
      : visibleView;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sceneKey]);

  useEffect(() => {
    if (!finishSystemRequested) {
      return;
    }
    setFinishSystemRequested(false);
    state.setup.onNext();
  }, [draft, finishSystemRequested, state.setup]);

  useEffect(() => {
    if (!state.setup.error || visibleView !== "setup" || draft.stage !== "details") {
      return;
    }
    const error = state.setup.error.toLowerCase();
    if (detailStep === "account") {
      if (error.includes("username")) setSetupField(0);
      else if (error.includes("personal agent")) setSetupField(1);
      else if (error.includes("do not match")) setSetupField(3);
      else if (error.includes("password")) setSetupField(2);
      return;
    }
    const sceneKey = (() => {
      if (error.includes("timezone")) return "setup-timezone";
      if (error.includes("admin passwords do not match")) return "setup-admin-password-confirm";
      if (error.includes("admin password")) return "setup-admin-password";
      if (error.includes("ai service")) return "setup-ai-provider";
      if (error.includes("ai model")) return "setup-ai-model";
      if (error.includes("device id")) return "setup-device-id";
      if (error.includes("expiry")) return "setup-device-expiry";
      return null;
    })();
    const index = sceneKey ? systemScenes.findIndex((scene) => scene.key === sceneKey) : -1;
    if (index >= 0) setSetupField(index);
  }, [detailStep, draft.stage, state.setup.error, systemScenes, visibleView]);

  const submitLoginStep = (event: Event): void => {
    event.preventDefault();
    if (state.busy) {
      return;
    }
    if (loginStep === "username") {
      const username = state.login.username.trim().toLowerCase();
      if (!username) {
        setLocalLoginError("Type the username you use with this GSV.");
        return;
      }
      state.login.onUsername(username);
      setLocalLoginError(null);
      setLoginStep("credential");
      return;
    }
    setLocalLoginError(null);
    state.login.onSubmit(event);
  };

  const changeCredentialKind = (next: CredentialKind): void => {
    setCredentialKind(next);
    setLocalLoginError(null);
    state.login.onPassword("");
    state.login.onToken("");
  };

  const advanceAccount = (): void => {
    if (accountIndex < accountScenes.length - 1) {
      setSetupField(accountIndex + 1);
      return;
    }
    setSetupField(0);
    state.setup.onNext();
  };

  const finishSystem = (): void => {
    setFinishSystemRequested(true);
  };

  const advanceSystem = (): void => {
    if (systemIndex < systemScenes.length - 1) {
      setSetupField(systemIndex + 1);
      return;
    }
    finishSystem();
  };

  const chooseSystemValue = (scene: ChoiceScene, choiceIndex: number): void => {
    const choice = scene.choices[choiceIndex];
    if (!choice) {
      return;
    }
    choice.choose();
    if (scene.key === "device" && choice.value === false) {
      finishSystem();
      return;
    }
    setSetupField(systemIndex + 1);
  };

  const submitSetupScene = (event: Event): void => {
    event.preventDefault();
    if (draft.stage === "review") {
      state.setup.onSubmit(event);
      return;
    }
    if (draft.stage !== "details") {
      return;
    }
    if (detailStep === "account") {
      advanceAccount();
      return;
    }
    advanceSystem();
  };

  const goBack = (): void => {
    if (visibleView === "login") {
      if (!state.busy && loginStep === "credential") {
        state.login.onPassword("");
        state.login.onToken("");
        setLoginStep("username");
        setLocalLoginError(null);
      }
      return;
    }
    if (visibleView !== "setup") {
      return;
    }
    if (draft.stage === "review") {
      state.setup.onBack();
      setSetupField(Math.max(0, systemScenes.length - 1));
      return;
    }
    if (draft.stage !== "details") {
      return;
    }
    if (setupField > 0) {
      setSetupField(setupField - 1);
      return;
    }
    state.setup.onBack();
    if (detailStep === "system") {
      setSetupField(accountScenes.length - 1);
    }
  };

  const onRootKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    if (visibleView === "setup" && draft.mode === "guided") {
      state.setup.onGuideToggle();
      return;
    }
    goBack();
  };

  const loginError = localLoginError ?? state.login.error;
  const setupError = state.setup.error;
  const setupResult = state.complete.setupResult;
  const provisioning = provisioningCopy(state.provisioning.pendingAction);

  return (
    <section
      class="text-session-screen"
      data-session-screen
      data-session-view={visibleView}
      hidden={visibleView === "desktop"}
      ref={state.refs.screenRef}
      onKeyDown={onRootKeyDown}
    >
      <div class="text-session-canvas" onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          inputRef.current?.focus({ preventScroll: true });
        }
      }}>
        {visibleView === "booting" ? (
          <div class="text-session-scene" key="booting" role="status" aria-live="polite">
            <span class="text-session-eyebrow">STARTING</span>
            <h1 class="text-session-question">Reaching your GSV…</h1>
            <p class="text-session-status">{state.boot.message || "ESTABLISHING A PRIVATE SESSION"}</p>
          </div>
        ) : null}

        {visibleView === "login" ? (
          <form class="text-session-scene" data-session-login-view key={sceneKey} onSubmit={submitLoginStep}>
            {state.busy ? (
              <>
                <span class="text-session-eyebrow">CONNECTING</span>
                <h1 class="text-session-question">Reaching your GSV…</h1>
                <p class="text-session-status">ESTABLISHING A PRIVATE SESSION</p>
              </>
            ) : loginStep === "username" ? (
              <>
                <span class="text-session-eyebrow">CONNECT · 01 / 02</span>
                <label class="text-session-question" for="username">Who are you?</label>
                <NativeInput
                  scene={{
                    key: "username",
                    eyebrow: "CONNECT · 01 / 02",
                    question: "Who are you?",
                    value: state.login.username,
                    placeholder: "username",
                    autoComplete: "username",
                    onValue: (value) => {
                      setLocalLoginError(null);
                      state.login.onUsername(value.toLowerCase());
                    },
                  }}
                  inputRef={inputRef}
                  dataAttribute="username"
                />
              </>
            ) : (
              <>
                <span class="text-session-eyebrow">CONNECT · 02 / 02</span>
                <label class="text-session-question" for={credentialKind}>
                  {credentialKind === "password" ? "Your password." : "Your access token."}
                </label>
                <NativeInput
                  scene={{
                    key: credentialKind,
                    eyebrow: "CONNECT · 02 / 02",
                    question: credentialKind === "password" ? "Your password." : "Your access token.",
                    value: credentialKind === "password" ? state.login.password : state.login.token,
                    placeholder: credentialKind === "password" ? "password" : "gsv_tok_…",
                    type: "password",
                    autoComplete: credentialKind === "password" ? "current-password" : "off",
                    onValue: (value) => {
                      setLocalLoginError(null);
                      if (credentialKind === "password") state.login.onPassword(value);
                      else state.login.onToken(value);
                    },
                  }}
                  inputRef={inputRef}
                  dataAttribute={credentialKind === "password" ? "password" : undefined}
                />
                <button
                  class="text-session-secondary-action"
                  type="button"
                  onClick={() => changeCredentialKind(credentialKind === "password" ? "token" : "password")}
                >
                  {credentialKind === "password" ? "USE A TOKEN" : "USE A PASSWORD"}
                </button>
              </>
            )}
            {loginError ? <p class="text-session-error" role="alert">COULDN’T CONTINUE · {loginError}</p> : null}
            {!state.busy ? <button class="text-session-submit" type="submit">Continue</button> : null}
          </form>
        ) : null}

        {visibleView === "setup" && draft.mode === "guided" ? (
          <section class="text-session-scene text-session-guide" data-setup-guide-panel key="setup-guide">
            <span class="text-session-eyebrow">SETUP GUIDE</span>
            <h1 class="text-session-question">What would help you decide?</h1>
            <div class="text-session-guide-log" data-setup-guide-log ref={state.refs.guideLogRef} aria-live="polite">
              {state.onboardingSnapshot.messages.length > 0 ? state.onboardingSnapshot.messages.map((entry, index) => (
                <article class={`text-session-guide-message is-${entry.role}`} key={`${entry.role}:${index}`}>
                  <span>{entry.role === "user" ? "YOU" : "GUIDE"}</span>
                  <p>{entry.content}</p>
                </article>
              )) : (
                <p class="text-session-status">ASK ABOUT ANY SETUP CHOICE · SECRET FIELDS STAY PRIVATE</p>
              )}
              {state.onboardingSnapshot.busy ? <p class="text-session-status">THINKING…</p> : null}
              {state.onboardingSnapshot.error ? <p class="text-session-error" role="alert">{state.onboardingSnapshot.error}</p> : null}
            </div>
            <textarea
              class="text-session-guide-input"
              data-setup-guide-input
              ref={state.refs.guideInputRef}
              rows={2}
              autoComplete="off"
              spellcheck={false}
              aria-label="Message the setup guide"
              placeholder="Ask the guide"
              value={state.setup.guideMessage}
              disabled={state.onboardingSnapshot.busy || state.busy}
              onInput={(event) => state.setup.onGuideMessage(event.currentTarget.value)}
              onKeyDown={state.setup.onGuideKeyDown}
            />
            <div class="text-session-complete-actions">
              <button
                type="button"
                class="text-session-submit"
                data-setup-guide-send
                disabled={!state.setup.guideMessage.trim() || state.onboardingSnapshot.busy || state.busy}
                onClick={state.setup.onGuideSend}
              >
                Ask
              </button>
              <button type="button" class="text-session-secondary-action" onClick={state.setup.onGuideToggle}>
                BACK TO SETUP · ESC
              </button>
            </div>
          </section>
        ) : visibleView === "setup" ? (
          <form
            class="text-session-scene"
            data-session-setup-view
            data-session-setup-form
            data-setup-stage={draft.stage}
            key={sceneKey}
            onSubmit={submitSetupScene}
          >
            {draft.stage === "welcome" ? (
              <>
                <span class="text-session-eyebrow">FIRST-TIME SETUP</span>
                <h1 class="text-session-question">Make this GSV yours.</h1>
                <div class="text-session-choices" aria-label="Setup path">
                  <button type="button" data-setup-lane onClick={() => {
                    setSetupField(0);
                    state.setup.onLane("quick");
                  }}>
                    <strong>Quick start</strong>
                    <small>Account, password, timezone.</small>
                  </button>
                  <button type="button" data-setup-lane onClick={() => {
                    setSetupField(0);
                    state.setup.onLane("customize");
                  }}>
                    <strong>Customize</strong>
                    <small>Choose security, AI, and devices.</small>
                  </button>
                </div>
              </>
            ) : draft.stage === "review" ? (
              <>
                <span class="text-session-eyebrow">CREATE · 03 / 03</span>
                <h1 class="text-session-question">Ready for {draft.account.username}?</h1>
                <div class="text-session-summary" aria-label="Setup summary">
                  <span>{draft.system.timezone}</span>
                  <span>{draft.admin.mode === "custom" ? "separate admin password" : "one account password"}</span>
                  <span>{buildAiSummary(draft)}</span>
                  <span>{buildDeviceSummary(draft)}</span>
                </div>
                <button class="text-session-submit" type="submit" data-setup-submit>Create this GSV</button>
              </>
            ) : detailStep === "account" ? (
              <section class="onboarding-section" data-setup-detail-step="account">
                <span class="text-session-eyebrow">{activeAccountScene.eyebrow}</span>
                <label class="text-session-question" for={activeAccountScene.key}>{activeAccountScene.question}</label>
                <NativeInput scene={activeAccountScene} inputRef={inputRef} />
                {activeAccountScene.optional ? <span class="text-session-status">OPTIONAL · ENTER SKIPS</span> : null}
                <button class="text-session-submit" type="submit">Continue</button>
              </section>
            ) : (
              <section class="onboarding-section" data-setup-detail-step="system">
                <span class="text-session-eyebrow">{activeSystemScene.eyebrow}</span>
                {isChoiceScene(activeSystemScene) ? (
                  <h1 class="text-session-question">{activeSystemScene.question}</h1>
                ) : (
                  <label class="text-session-question" for={activeSystemScene.key}>{activeSystemScene.question}</label>
                )}
                {isChoiceScene(activeSystemScene) ? (
                  <div class="text-session-choices is-compact">
                    {activeSystemScene.choices.map((choice, index) => (
                      <button
                        type="button"
                        class={choice.value === activeSystemScene.value ? "is-selected" : ""}
                        key={`${activeSystemScene.key}:${String(choice.value)}`}
                        onClick={() => chooseSystemValue(activeSystemScene, index)}
                      >
                        <strong>{choice.label}</strong>
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <NativeInput scene={activeSystemScene} inputRef={inputRef} />
                    {activeSystemScene.key === "setup-timezone" ? (
                      <datalist id="text-session-timezones">
                        {state.setup.timezoneOptions.map((zone) => <option key={zone} value={zone} />)}
                      </datalist>
                    ) : null}
                    {activeSystemScene.key === "setup-ai-provider" ? (
                      <datalist id="text-session-ai-providers">
                        {AI_PROVIDER_OPTIONS.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}
                      </datalist>
                    ) : null}
                    {activeSystemScene.optional ? <span class="text-session-status">OPTIONAL · ENTER SKIPS</span> : null}
                    <button class="text-session-submit" type="submit">Continue</button>
                  </>
                )}
              </section>
            )}
            {setupError ? <p class="text-session-error" role="alert">COULDN’T CONTINUE · {setupError}</p> : null}
            {draft.stage !== "welcome" ? (
              <button type="button" class="text-session-secondary-action" onClick={state.setup.onGuideToggle}>
                ASK THE SETUP GUIDE
              </button>
            ) : null}
          </form>
        ) : null}

        {visibleView === "provisioning" ? (
          <div class="text-session-scene" data-session-provisioning-view role="status" aria-live="polite">
            <span class="text-session-eyebrow">SETTING UP</span>
            <h1 class="text-session-question" data-session-provisioning-title>{provisioning.title}…</h1>
            <p class="text-session-status" data-session-provisioning-copy>{provisioning.copy}</p>
          </div>
        ) : null}

        {visibleView === "complete" ? (
          <div class="text-session-scene" data-session-setup-complete>
            <span class="text-session-eyebrow">READY</span>
            <h1 class="text-session-question">Your workspace is ready.</h1>
            <p class="text-session-value" data-setup-result-username>{setupResult.username}</p>
            {state.complete.error ? <p class="text-session-error" role="alert">COULDN’T CONTINUE · {state.complete.error}</p> : null}
            <div class="text-session-complete-actions">
              <button
                class="text-session-submit"
                type="button"
                data-session-setup-continue
                ref={state.refs.continueButtonRef}
                disabled={state.busy}
                onClick={state.complete.onContinue}
              >
                Open GSV
              </button>
              <button type="button" class="text-session-secondary-action" data-setup-copy-cli onClick={state.complete.onCopyCli}>
                COPY CLI INSTALL
              </button>
              {setupResult.node.visible ? (
                <button type="button" class="text-session-secondary-action" data-setup-copy-token onClick={state.complete.onCopyToken}>
                  COPY DEVICE SETUP
                </button>
              ) : null}
            </div>
            <textarea
              class="text-session-copy-source"
              data-setup-result-cli-command
              ref={state.refs.cliCommandRef}
              readOnly
              value={setupResult.cliCommand}
              aria-label="CLI install command"
            />
            <textarea
              class="text-session-copy-source"
              data-setup-result-node-token
              ref={state.refs.nodeCommandRef}
              readOnly
              value={setupResult.node.command}
              aria-label="Device setup command"
            />
          </div>
        ) : null}
      </div>

      {visibleView === "login" && !state.busy ? (
        <footer class="text-session-footer">
          <ProgressMarkers count={2} current={loginStep === "username" ? 0 : 1} />
          <button type="button" onClick={goBack} disabled={loginStep === "username"}>
            {loginStep === "username" ? "ENTER CONTINUES" : "ENTER CONNECTS · ESC GOES BACK"}
          </button>
        </footer>
      ) : null}
      {visibleView === "setup" && draft.stage !== "welcome" ? (
        <footer class="text-session-footer">
          <ProgressMarkers count={3} current={draft.stage === "review" ? 2 : detailStep === "account" ? 0 : 1} />
          <button type="button" onClick={goBack}>ENTER CONTINUES · ESC GOES BACK</button>
        </footer>
      ) : null}
    </section>
  );
}
