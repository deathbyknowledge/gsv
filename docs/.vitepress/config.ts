import { defineConfig } from "vitepress";

export default defineConfig({
  title: "GSV",
  description:
    "An open-source personal AI computer that spans all your devices and stays awake when they're asleep. One mind across your machines — not rented, not stuck on one box.",
  cleanUrls: true,

  redirects: {
    // explanation → architecture
    "/explanation/architecture": "/architecture/",
    "/explanation/agent-loop": "/architecture/agent-loop",
    "/explanation/channel-model": "/architecture/adapter-model",
    "/explanation/context-compaction": "/architecture/context-compaction",
    "/explanation/process-ipc-and-scheduler": "/architecture/process-ipc-and-scheduler",
    "/explanation/security-model": "/architecture/security-model",

    // tutorials → get-started
    "/tutorials/getting-started": "/get-started/",
    "/tutorials/setting-up-a-channel": "/get-started/connect-adapters",

    // top-level orphans
    "/process-spawn-handoff-model": "/architecture/process-handoffs",
    "/context-memory-knowledge-architecture": "/architecture/context-and-knowledge",

    // how-to renames
    "/how-to/manage-channels": "/how-to/manage-adapters",
    "/how-to/manage-sessions": "/how-to/manage-processes",
    "/how-to/run-a-node": "/how-to/run-a-device",

    // why orphans
    "/why/examples": "/why/use-cases",
    "/why/why": "/why/",

    // get-started renames
    "/get-started/cf-setup": "/get-started/cloudflare-setup",
    "/get-started/getting-started": "/get-started/",
    "/get-started/setting-up-a-channel": "/get-started/connect-adapters",

    // architecture renames
    "/architecture/channel-model": "/architecture/adapter-model",

    // reference renames
    "/reference/native-tools": "/reference/hardware-tools",
    "/reference/session-routing": "/reference/routing",
    "/reference/workspace-files": "/reference/context-files",
  },

  sitemap: {
    hostname: "https://gsv.dev",
  },

  lastUpdated: true,

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#6b8f71" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "An open-source personal AI computer that spans all your devices and stays awake when they're asleep. One mind across your machines — not rented, not stuck on one box.",
      },
    ],
    ["meta", { property: "og:title", content: "GSV" }],
  ],

  themeConfig: {
    nav: [
      { text: "Why GSV?", link: "/why/" },
      { text: "Get Started", link: "/get-started/" },
      { text: "Guides", link: "/how-to/" },
      { text: "Reference", link: "/reference/" },
      { text: "Architecture", link: "/architecture/" },
    ],

    sidebar: {
      "/why/": [
        {
          text: "Why GSV?",
          items: [
            { text: "Why GSV?", link: "/why/" },
            { text: "Use Cases", link: "/why/use-cases" },
          ],
        },
      ],

      "/get-started/": [
        {
          text: "Get Started",
          items: [
            { text: "Overview", link: "/get-started/" },
            { text: "Set Up Cloudflare", link: "/get-started/cloudflare-setup" },
            { text: "Connect Adapters", link: "/get-started/connect-adapters" },
          ],
        },
      ],

      "/how-to/": [
        {
          text: "Guides",
          items: [
            { text: "Overview", link: "/how-to/" },
            { text: "Deploy GSV", link: "/how-to/deploy" },
            { text: "Configure an Agent", link: "/how-to/configure-agent" },
            { text: "Run a Device", link: "/how-to/run-a-device" },
            { text: "Manage Processes", link: "/how-to/manage-processes" },
            { text: "Configure Automation", link: "/how-to/set-up-cron" },
            { text: "Manage Adapters", link: "/how-to/manage-adapters" },
            { text: "Write a Package App", link: "/how-to/write-a-package-app" },
          ],
        },
      ],

      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Overview", link: "/reference/" },
            { text: "CLI Commands", link: "/reference/cli-commands" },
            { text: "WebSocket Protocol", link: "/reference/websocket-protocol" },
            { text: "Syscalls", link: "/reference/syscalls" },
            { text: "Configuration", link: "/reference/configuration" },
            { text: "Context Files", link: "/reference/context-files" },
            { text: "Hardware Tools", link: "/reference/hardware-tools" },
            { text: "Routing", link: "/reference/routing" },
            { text: "Storage", link: "/reference/r2-storage" },
            { text: "Package SDK", link: "/reference/package-sdk" },
          ],
        },
      ],

      "/architecture/": [
        {
          text: "Architecture",
          items: [
            { text: "Architecture Overview", link: "/architecture/" },
            { text: "The Agent Loop", link: "/architecture/agent-loop" },
            { text: "Process IPC and Scheduler", link: "/architecture/process-ipc-and-scheduler" },
            { text: "Context Compaction & Memory", link: "/architecture/context-compaction" },
            { text: "Context and Knowledge", link: "/architecture/context-and-knowledge" },
            { text: "Process Handoffs", link: "/architecture/process-handoffs" },
            { text: "The Adapter Model", link: "/architecture/adapter-model" },
            { text: "Security Model", link: "/architecture/security-model" },
          ],
        },
      ],
    },

    socialLinks: [{ icon: "github", link: "https://github.com/deathbyknowledge/gsv" }],

    search: {
      provider: "local",
    },

    outline: {
      level: [2, 3],
    },
  },
});
