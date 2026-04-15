import { definePackage } from "@gsv/package/worker";

export default definePackage({
  meta: {
    displayName: "Preact Lab",
    description: "Small TSX SPA proving the package runtime path.",
    window: {
      width: 960,
      height: 720,
      minWidth: 640,
      minHeight: 480,
    },
  },
  app: {
    browser: {
      entry: "./index.html",
    },
  },
});
