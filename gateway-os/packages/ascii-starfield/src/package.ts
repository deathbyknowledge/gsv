import { definePackage } from "@gsv/package/worker";

export default definePackage({
  meta: {
    displayName: "Starfield",
    description: "ASCII starfield flight demo.",
    window: {
      width: 1220,
      height: 820,
      minWidth: 720,
      minHeight: 480,
    },
  },
  app: {
    browser: {
      entry: "./index.html",
    },
  },
});
