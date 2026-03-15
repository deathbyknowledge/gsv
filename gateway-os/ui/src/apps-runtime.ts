import type { AppManifest } from "./apps";
import type { AppInstance, AppRuntimeContext, AppRuntimeRegistry } from "./app-runtime";
import { createChatAppInstance } from "./chat-app";
import type { GatewayClient } from "./gateway-client";

type AppCopy = {
  eyebrow: string;
  intro: string;
  cards: readonly {
    title: string;
    body: string;
  }[];
};

const APP_COPY: Record<string, AppCopy> = {
  chat: {
    eyebrow: "Conversation Surface",
    intro: "Multi-process chat UI with adapter-aware routing and run-state visibility.",
    cards: [
      {
        title: "Runs",
        body: "Active run tracking, completion state, and route diagnostics.",
      },
      {
        title: "Context",
        body: "Per-process history controls and tool trace expansion.",
      },
      {
        title: "Signals",
        body: "Live stream of chat.text, chat.complete, and tool events.",
      },
    ],
  },
  shell: {
    eyebrow: "Command Surface",
    intro: "Device-oriented shell execution with target routing and process-level identity.",
    cards: [
      {
        title: "Sessions",
        body: "Foreground/background command streams with signal forwarding.",
      },
      {
        title: "Targets",
        body: "Direct execution on connected devices through kernel dispatch.",
      },
      {
        title: "History",
        body: "Command logs with durable archiving and replay controls.",
      },
    ],
  },
  files: {
    eyebrow: "Workspace Surface",
    intro: "Virtual filesystem browser across /sys, /proc, /dev, and user workspaces.",
    cards: [
      {
        title: "Explorer",
        body: "Path navigation with mode bits and owner/group metadata.",
      },
      {
        title: "Editor",
        body: "Inline read/write/edit flows backed by kernel fs syscalls.",
      },
      {
        title: "Search",
        body: "Fast query over workspace files with mount-aware filtering.",
      },
    ],
  },
  control: {
    eyebrow: "System Surface",
    intro: "Kernel health, permissions, tokens, and adapter status in one control plane.",
    cards: [
      {
        title: "Identity",
        body: "User, machine-token, and link status with audit trails.",
      },
      {
        title: "Capabilities",
        body: "Group capability snapshots and grant/revoke workflows.",
      },
      {
        title: "Infrastructure",
        body: "Workers, adapters, and process topology observability.",
      },
    ],
  },
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function resolveCopy(manifest: AppManifest): AppCopy {
  return (
    APP_COPY[manifest.id] ?? {
      eyebrow: "Application Surface",
      intro: manifest.description,
      cards: [
        {
          title: "Entrypoint",
          body: `${manifest.entrypoint.kind} -> ${manifest.entrypoint.route}`,
        },
        {
          title: "Permissions",
          body: manifest.permissions.join(", ") || "none",
        },
      ],
    }
  );
}

function renderMarkup(context: AppRuntimeContext, copy: AppCopy): string {
  const cardsMarkup = copy.cards
    .map((card) => {
      return `<article><h2>${escapeHtml(card.title)}</h2><p>${escapeHtml(card.body)}</p></article>`;
    })
    .join("");

  const permissionTagsMarkup = context.manifest.permissions
    .map((permission) => `<span class="app-tag">${escapeHtml(permission)}</span>`)
    .join("");

  return `
    <section class="app-grid">
      <p class="eyebrow">${escapeHtml(copy.eyebrow)}</p>
      <h1>${escapeHtml(context.manifest.name)}</h1>
      <p>${escapeHtml(copy.intro)}</p>
      <div class="app-tag-row">
        <span class="app-tag" data-runtime-state-label>running</span>
        <span class="app-tag" data-runtime-uptime>uptime 0:00</span>
        ${permissionTagsMarkup}
      </div>
      <div class="mock-grid">${cardsMarkup}</div>
    </section>
  `;
}

function createMockAppInstance(manifest: AppManifest): AppInstance {
  const copy = resolveCopy(manifest);

  let containerNode: HTMLElement | null = null;
  let stateLabelNode: HTMLElement | null = null;
  let uptimeNode: HTMLElement | null = null;
  let tickTimer: number | null = null;
  let elapsedMs = 0;
  let startedAtMs: number | null = null;

  const renderUptime = (): void => {
    if (!uptimeNode) {
      return;
    }

    const liveElapsed = startedAtMs === null ? elapsedMs : elapsedMs + (Date.now() - startedAtMs);
    uptimeNode.textContent = `uptime ${formatDuration(liveElapsed)}`;
  };

  const stopTicker = (): void => {
    if (tickTimer !== null) {
      window.clearInterval(tickTimer);
      tickTimer = null;
    }

    if (startedAtMs !== null) {
      elapsedMs += Date.now() - startedAtMs;
      startedAtMs = null;
    }

    renderUptime();
  };

  const startTicker = (): void => {
    if (tickTimer !== null || !uptimeNode) {
      return;
    }

    startedAtMs = Date.now();
    renderUptime();
    tickTimer = window.setInterval(renderUptime, 1_000);
  };

  const setState = (value: "running" | "suspended"): void => {
    if (stateLabelNode) {
      stateLabelNode.textContent = value;
    }

    if (containerNode) {
      containerNode.dataset.runtimeState = value;
    }
  };

  return {
    mount: (container, context) => {
      container.innerHTML = renderMarkup(context, copy);
      containerNode = container;
      stateLabelNode = container.querySelector<HTMLElement>("[data-runtime-state-label]");
      uptimeNode = container.querySelector<HTMLElement>("[data-runtime-uptime]");
      elapsedMs = 0;
      startedAtMs = null;
      setState("running");
      startTicker();
    },
    suspend: () => {
      setState("suspended");
      stopTicker();
    },
    resume: () => {
      setState("running");
      startTicker();
    },
    terminate: () => {
      stopTicker();
      if (containerNode) {
        containerNode.removeAttribute("data-runtime-state");
      }
      containerNode = null;
      stateLabelNode = null;
      uptimeNode = null;
    },
  };
}

export function createAppRuntime(gatewayClient: GatewayClient): AppRuntimeRegistry {
  return {
    createInstance: (manifest) => {
      if (manifest.id === "chat") {
        return createChatAppInstance(gatewayClient);
      }

      return createMockAppInstance(manifest);
    },
  };
}
