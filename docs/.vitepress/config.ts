import { defineConfig } from "vitepress";

export default defineConfig({
  title: "GSV",
  description: "Documentation for the General Systems Vehicle platform",
  cleanUrls: true,

  head: [
    ["meta", { name: "theme-color", content: "#5b7ee5" }],
  ],

  themeConfig: {
    nav: [
      { text: "Tutorials", link: "/tutorials/getting-started" },
      { text: "How-to Guides", link: "/how-to/deploy" },
      { text: "Reference", link: "/reference/cli-commands" },
      { text: "Explanation", link: "/explanation/architecture" },
    ],

    sidebar: {
      "/tutorials/": [
        {
          text: "Tutorials",
          items: [
            { text: "Getting Started", link: "/tutorials/getting-started" },
            { text: "Connecting Adapters", link: "/tutorials/setting-up-a-channel" },
          ],
        },
      ],

      "/how-to/": [
        {
          text: "How-to Guides",
          items: [
            { text: "Deploy GSV", link: "/how-to/deploy" },
            { text: "Configure an Agent", link: "/how-to/configure-agent" },
            { text: "Write a Package App", link: "/how-to/write-a-package-app" },
            { text: "Run a Device", link: "/how-to/run-a-node" },
            { text: "Manage Processes", link: "/how-to/manage-sessions" },
            { text: "Configure Automation", link: "/how-to/set-up-cron" },
            { text: "Manage Adapters", link: "/how-to/manage-channels" },
          ],
        },
      ],

      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "CLI Commands", link: "/reference/cli-commands" },
            { text: "Package SDK", link: "/reference/package-sdk" },
            { text: "WebSocket Protocol", link: "/reference/websocket-protocol" },
            { text: "Syscalls", link: "/reference/syscalls" },
            { text: "Configuration", link: "/reference/configuration" },
            { text: "Context Files", link: "/reference/workspace-files" },
            { text: "Hardware Tools", link: "/reference/native-tools" },
            { text: "Routing", link: "/reference/session-routing" },
            { text: "Storage", link: "/reference/r2-storage" },
          ],
        },
      ],

      "/explanation/": [
        {
          text: "Explanation",
          items: [
            { text: "Architecture Overview", link: "/explanation/architecture" },
            { text: "The Agent Loop", link: "/explanation/agent-loop" },
            { text: "Context Compaction & Memory", link: "/explanation/context-compaction" },
            { text: "The Channel Model", link: "/explanation/channel-model" },
            { text: "Security Model", link: "/explanation/security-model" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/deathbyknowledge/gsv" },
    ],

    search: {
      provider: "local",
    },

    outline: {
      level: [2, 3],
    },
  },
});
