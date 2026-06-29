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
    "/tutorials/setting-up-a-channel": "/how-to/messengers",

    // top-level orphans
    "/process-spawn-handoff-model": "/architecture/process-handoffs",
    "/context-memory-knowledge-architecture": "/architecture/context-and-knowledge",

    // how-to renames
    "/how-to/manage-channels": "/how-to/messengers",
    "/how-to/manage-sessions": "/how-to/",
    "/how-to/run-a-node": "/how-to/connect-devices",
    "/how-to/manage-adapters": "/how-to/messengers",
    "/how-to/manage-processes": "/how-to/",
    "/how-to/run-a-device": "/how-to/connect-devices",
    "/how-to/configure-agent": "/how-to/",
    "/how-to/set-up-cron": "/how-to/",
    "/how-to/write-a-package-app": "/how-to/applications",

    // why orphans
    "/why/examples": "/examples/",
    "/why/use-cases": "/examples/",
    "/why/why": "/why/",

    // get-started renames
    "/get-started/cf-setup": "/how-to/deploy",
    "/get-started/getting-started": "/get-started/",
    "/get-started/setting-up-a-channel": "/how-to/messengers",
    "/get-started/cloudflare-setup": "/how-to/deploy",
    "/get-started/connect-adapters": "/how-to/messengers",

    // architecture renames
    "/architecture/channel-model": "/architecture/adapter-model",

    // reference renames
    "/reference/native-tools": "/reference/hardware-tools",
    "/reference/session-routing": "/reference/routing",
    "/reference/workspace-files": "/reference/context-files",
  },

  sitemap: {
    hostname: "https://docs.gsv.space",
  },

  lastUpdated: true,

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#0a0820" }],
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
    siteTitle: false,
    logo: null,

    nav: [
      { text: "Why GSV?", link: "/why/" },
      { text: "Get Started", link: "/get-started/" },
      { text: "Examples", link: "/examples/" },
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
          ],
        },
      ],

      "/examples/": [
        {
          text: "Examples",
          items: [
            { text: "Overview", link: "/examples/" },
          ],
        },
      ],

      "/get-started/": [
        {
          text: "Get Started",
          items: [
            { text: "Overview", link: "/get-started/" },
            { text: "FAQ", link: "/get-started/faq" },
          ],
        },
      ],

      "/how-to/": [
        {
          text: "Guides",
          items: [
            { text: "Overview", link: "/how-to/" },
            { text: "Deploy / Update / Remove", link: "/how-to/deploy" },
            { text: "Connect Devices", link: "/how-to/connect-devices" },
            { text: "Connect a Messenger", link: "/how-to/messengers" },
            { text: "Bring Your Own Model", link: "/how-to/bring-your-own-model" },
            { text: "Integrations (MCP)", link: "/how-to/integrations" },
            { text: "Applications", link: "/how-to/applications" },
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

    socialLinks: [
      { icon: "github", link: "https://github.com/deathbyknowledge/gsv" },
      { icon: "x", link: "https://x.com/gsvspace" },
      { icon: "discord", link: "https://discord.gg/hy9ExJJFvn" },
    ],

    search: {
      provider: "local",
    },

    outline: {
      level: [2, 3],
    },
  },
});
