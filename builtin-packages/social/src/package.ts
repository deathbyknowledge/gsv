import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Social",
    description: "Public identity, known contacts, channel conversations, and published GSV records.",
    window: {
      width: 1180,
      height: 760,
      minWidth: 900,
      minHeight: 560,
    },
    capabilities: {
      kernel: [
        "social.identity.get",
        "social.identity.republish",
        "social.contact.list",
        "social.contact.add",
        "social.contact.remove",
        "social.contact.grants.set",
        "social.contact.public.list",
        "social.contact.publish",
        "social.contact.unpublish",
        "social.user.list",
        "social.package.list",
        "social.package.release.list",
        "social.vouch.create",
        "social.vouch.delete",
        "social.vouch.list",
        "social.news.create",
        "social.news.delete",
        "social.news.list",
        "social.thread.list",
        "social.thread.get",
        "social.message.send",
        "social.message.status.list",
        "social.message.status.get",
        "social.message.status.update",
      ],
    },
  },
  browser: {
    entry: "./src/main.tsx",
    assets: [
      "./src/styles.css",
      "./src/styles/base.css",
      "./src/styles/layout.css",
      "./src/styles/navigation.css",
      "./src/styles/sections.css",
      "./src/styles/forms.css",
      "./src/styles/responsive.css",
    ],
  },
  backend: {
    entry: "./src/backend.ts",
  },
  cli: {
    commands: {
      social: "./src/cli/social.ts",
    },
  },
});
