import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Social",
    description: "Friends, grants, social threads, and typed requests between GSV instances.",
    window: {
      width: 1180,
      height: 760,
      minWidth: 900,
      minHeight: 560,
    },
    capabilities: {
      kernel: [
        "social.identity.get",
        "social.friend.list",
        "social.friend.add",
        "social.friend.remove",
        "social.friend.grants.set",
        "social.thread.list",
        "social.thread.get",
        "social.message.send",
        "social.message.reply",
        "social.request.create",
        "social.request.list",
        "social.request.get",
        "social.request.respond",
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
});
