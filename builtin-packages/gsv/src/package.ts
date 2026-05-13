import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "GSV",
    description: "System console for operating and configuring GSV.",
    window: {
      width: 1220,
      height: 820,
      minWidth: 360,
      minHeight: 520,
    },
  },
  browser: {
    entry: "./src/main.tsx",
    assets: [
      "./src/styles.css",
      "./src/styles/base.css",
      "./src/styles/shell.css",
      "./src/styles/sections.css",
      "./src/styles/responsive.css",
    ],
  },
});
