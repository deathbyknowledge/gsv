import type { SessionService, SessionSnapshot } from "./session-service";

type SessionUiOptions = {
  rootNode: HTMLElement;
  session: SessionService;
};

type SessionUiController = {
  destroy: () => void;
};

function statusText(snapshot: SessionSnapshot): string {
  switch (snapshot.phase) {
    case "ready":
      return "session: connected";
    case "authenticating":
      return "session: authenticating...";
    default:
      return "session: locked";
  }
}

export function createSessionUi(options: SessionUiOptions): SessionUiController {
  const { rootNode, session } = options;

  const overlayNode = rootNode.querySelector<HTMLElement>("[data-session-overlay]");
  const formNode = rootNode.querySelector<HTMLFormElement>("[data-session-form]");
  const usernameInputNode = rootNode.querySelector<HTMLInputElement>("[data-session-username]");
  const passwordInputNode = rootNode.querySelector<HTMLInputElement>("[data-session-password]");
  const tokenInputNode = rootNode.querySelector<HTMLInputElement>("[data-session-token]");
  const errorNode = rootNode.querySelector<HTMLElement>("[data-session-error]");
  const submitNode = rootNode.querySelector<HTMLButtonElement>("[data-session-submit]");
  const statusNode = rootNode.querySelector<HTMLElement>("[data-session-status]");
  const dotNode = rootNode.querySelector<HTMLElement>("[data-session-dot]");
  const lockNode = rootNode.querySelector<HTMLButtonElement>("[data-session-lock]");

  if (
    !overlayNode ||
    !formNode ||
    !usernameInputNode ||
    !passwordInputNode ||
    !tokenInputNode ||
    !errorNode ||
    !submitNode ||
    !statusNode ||
    !dotNode ||
    !lockNode
  ) {
    throw new Error("Session UI markup is incomplete");
  }

  const applySnapshot = (snapshot: SessionSnapshot): void => {
    statusNode.textContent = statusText(snapshot);
    overlayNode.hidden = snapshot.phase === "ready";
    submitNode.disabled = snapshot.phase === "authenticating";
    lockNode.disabled = snapshot.phase !== "ready";

    dotNode.classList.toggle("is-online", snapshot.phase === "ready");
    dotNode.classList.toggle("is-pending", snapshot.phase === "authenticating");
    dotNode.classList.toggle("is-offline", snapshot.phase === "locked");

    if (snapshot.phase === "locked" && snapshot.message) {
      errorNode.hidden = false;
      errorNode.textContent = snapshot.message;
    } else {
      errorNode.hidden = true;
      errorNode.textContent = "";
    }

    if (snapshot.phase === "ready") {
      passwordInputNode.value = "";
      tokenInputNode.value = "";
      return;
    }

    if (snapshot.username && !usernameInputNode.value) {
      usernameInputNode.value = snapshot.username;
    }

    if (snapshot.phase === "locked") {
      passwordInputNode.focus();
    }
  };

  const onSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();

    const username = usernameInputNode.value.trim();
    const password = passwordInputNode.value.trim();
    const token = tokenInputNode.value.trim();

    if (!username) {
      errorNode.hidden = false;
      errorNode.textContent = "Username is required.";
      return;
    }
    if (!password && !token) {
      errorNode.hidden = false;
      errorNode.textContent = "Provide password or token.";
      return;
    }
    if (password && token) {
      errorNode.hidden = false;
      errorNode.textContent = "Use either password or token.";
      return;
    }

    try {
      await session.login({
        username,
        ...(token ? { token } : { password }),
      });
    } catch {
      // Error is reflected through session snapshot.
    }
  };

  const onLockClick = (): void => {
    session.lock();
  };

  formNode.addEventListener("submit", onSubmit);
  lockNode.addEventListener("click", onLockClick);

  const unsubscribe = session.subscribe((snapshot) => {
    applySnapshot(snapshot);
  });

  return {
    destroy: () => {
      unsubscribe();
      formNode.removeEventListener("submit", onSubmit);
      lockNode.removeEventListener("click", onLockClick);
    },
  };
}
