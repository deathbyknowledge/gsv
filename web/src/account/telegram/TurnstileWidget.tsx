import { useEffect, useRef } from "preact/hooks";

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance: "interaction-only";
      size: "flexible";
      theme: "dark";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScript: Promise<TurnstileApi> | null = null;

export function TurnstileWidget({
  siteKey,
  resetKey,
  onToken,
  onError,
}: {
  siteKey: string;
  resetKey: number;
  onToken: (token: string | null) => void;
  onError: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let widgetId: string | null = null;
    onToken(null);
    void loadTurnstile().then((turnstile) => {
      if (disposed || !container.current) return;
      widgetId = turnstile.render(container.current, {
        sitekey: siteKey,
        action: "passkey_login",
        appearance: "interaction-only",
        size: "flexible",
        theme: "dark",
        callback: (token) => onToken(token),
        "error-callback": () => {
          onToken(null);
          onError();
        },
        "expired-callback": () => onToken(null),
      });
    }).catch(() => {
      if (!disposed) onError();
    });
    return () => {
      disposed = true;
      if (widgetId && window.turnstile) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [siteKey, resetKey]);

  return <div class="account-turnstile" ref={container} />;
}

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScript) return turnstileScript;
  turnstileScript = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile did not initialize"));
    }, { once: true });
    script.addEventListener("error", () => {
      turnstileScript = null;
      reject(new Error("Turnstile could not be loaded"));
    }, { once: true });
    document.head.append(script);
  });
  return turnstileScript;
}
