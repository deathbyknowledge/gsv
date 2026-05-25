import { defineConfig } from "vitepress";

export default defineConfig({
  title: "GSV",
  description:
    "A durable cloud computer for humans, machines, and agents — persistent processes, device nodes, and automated workflows.",
  cleanUrls: true,

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
          "A durable cloud computer for humans, machines, and agents — persistent processes, device nodes, and automated workflows.",
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
