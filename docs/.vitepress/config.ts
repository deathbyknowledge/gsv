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
            { text: "Setting Up a Channel", link: "/tutorials/setting-up-a-channel" },
            { text: "Writing a Skill", link: "/tutorials/writing-a-skill" },
          ],
        },
      ],

      "/how-to/": [
        {
          text: "How-to Guides",
          items: [
            { text: "Deploy GSV", link: "/how-to/deploy" },
            { text: "Configure an Agent", link: "/how-to/configure-agent" },
            { text: "Run a Node", link: "/how-to/run-a-node" },
            { text: "Manage Sessions", link: "/how-to/manage-sessions" },
            { text: "Set Up Cron Jobs", link: "/how-to/set-up-cron" },
            { text: "Manage Channels", link: "/how-to/manage-channels" },
          ],
        },
      ],

      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "CLI Commands", link: "/reference/cli-commands" },
            { text: "WebSocket Protocol", link: "/reference/websocket-protocol" },
            { text: "Configuration", link: "/reference/configuration" },
            { text: "Workspace Files", link: "/reference/workspace-files" },
            { text: "Native Tools (gsv__)", link: "/reference/native-tools" },
            { text: "Node Tools", link: "/reference/node-tools" },
            { text: "Skills Frontmatter", link: "/reference/skills-frontmatter" },
            { text: "Session Routing", link: "/reference/session-routing" },
            { text: "R2 Storage Layout", link: "/reference/r2-storage" },
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
