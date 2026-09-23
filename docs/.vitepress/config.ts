import { defineConfig } from "vitepress";

export default defineConfig({
  title: "GSV docs",
  description:
    "GSV docs — an open-source personal AI computer, a distributed OS with AI in the kernel, that spans all your devices and stays always-on in your own Cloudflare account.",
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
    "/tutorials/setting-up-an-adapter": "/how-to/messengers",

    // top-level orphans
    "/process-spawn-handoff-model": "/architecture/process-ipc-and-scheduler",
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
    "/how-to/write-a-package-app": "/how-to/",
    "/how-to/pr-previews": "/how-to/",

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
          "GSV docs — an open-source personal AI computer, a distributed OS with AI in the kernel, that spans all your devices and stays always-on in your own Cloudflare account.",
      },
    ],
    ["meta", { property: "og:title", content: "GSV docs" }],
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
            { text: "Deploy with Alchemy", link: "/how-to/deploy-with-alchemy" },
            { text: "Operate a GSV Deployment", link: "/how-to/operate-gsv" },
            { text: "Retire a Standalone Deployment", link: "/how-to/standalone-retirement" },
            { text: "Run GSV for Your Organisation", link: "/how-to/organisations" },
            { text: "Invite People", link: "/how-to/invite-people" },
            { text: "Install Host Applications", link: "/how-to/install-host-apps" },
            { text: "Connect Devices", link: "/how-to/connect-devices" },
            { text: "Connect a Messenger", link: "/how-to/messengers" },
            { text: "Bring Your Own Model", link: "/how-to/bring-your-own-model" },
            { text: "Integrations (MCP)", link: "/how-to/integrations" },
            { text: "Browse the Web", link: "/how-to/browse-web" },
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
            { text: "Target Tools", link: "/reference/hardware-tools" },
            { text: "Routing", link: "/reference/routing" },
            { text: "Storage", link: "/reference/r2-storage" },
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
            { text: "Process History", link: "/architecture/process-history" },
            { text: "Responsibilities and Context Epochs", link: "/architecture/responsibilities-and-context-epochs" },
          ],
        },
        {
          text: "Context and Memory",
          collapsed: true,
          items: [
            { text: "Context Compaction & Memory", link: "/architecture/context-compaction" },
            { text: "Context and Knowledge", link: "/architecture/context-and-knowledge" },
            { text: "Conversations", link: "/architecture/conversations" },
          ],
        },
        {
          text: "Surfaces and Peers",
          collapsed: true,
          items: [
            { text: "The Adapter Model", link: "/architecture/adapter-model" },
            { text: "Unified Protocol Peers", link: "/architecture/unified-protocol-peers" },
            { text: "Interaction Surface Bindings", link: "/architecture/interaction-surface-bindings" },
            { text: "Targets", link: "/architecture/targets" },
            { text: "Rust Host Applications", link: "/architecture/rust-host-applications" },
            { text: "Resource References", link: "/architecture/resource-references" },
          ],
        },
        {
          text: "Operations",
          collapsed: true,
          items: [
            { text: "Security Model", link: "/architecture/security-model" },
            { text: "The Ledger", link: "/architecture/ledger" },
            { text: "Services", link: "/architecture/services" },
            { text: "Telemetry", link: "/architecture/telemetry" },
            { text: "Installation Directory", link: "/architecture/installation-directory" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/deathbyknowledge/gsv" },
      { icon: "x", link: "https://x.com/humachinesinc" },
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
