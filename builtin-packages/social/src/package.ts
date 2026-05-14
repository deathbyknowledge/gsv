import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Social",
    description: "Friends, grants, inbox status, and message threads between GSV instances.",
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
        "social.friend.list",
        "social.friend.add",
        "social.friend.remove",
        "social.friend.grants.set",
        "social.user.list",
        "social.package.like.create",
        "social.package.like.delete",
        "social.package.like.list",
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
    assets: ["./src/styles.css"],
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
