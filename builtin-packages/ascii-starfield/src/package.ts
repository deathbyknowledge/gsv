import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Starfield",
    description: "ASCII starfield flight demo.",
    icon: "ui/starfield-icon.svg",
    window: {
      width: 1220,
      height: 820,
      minWidth: 720,
      minHeight: 480,
    },
  },
  browser: {
    entry: "./src/ascii-starfield-main.ts",
    assets: ["./src/ascii-starfield.css"],
  },
});
