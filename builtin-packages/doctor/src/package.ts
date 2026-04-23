import { definePackage } from "@gsv/package/manifest";

export default definePackage({
  meta: {
    displayName: "Doctor",
    description: "CLI doctor command scaffold for GSV status checks.",
  },
  cli: {
    commands: {
      doctor: "./src/cli/doctor.ts",
    },
  },
});
