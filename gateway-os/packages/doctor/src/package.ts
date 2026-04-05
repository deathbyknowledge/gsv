import { definePackage } from "@gsv/package/worker";

export default definePackage({
  meta: {
    displayName: "Doctor",
    description: "CLI doctor command scaffold for GSV status checks.",
  },

  commands: {
    async doctor(ctx) {
      await ctx.stdout.write("gsv doctor: status checks are not implemented yet\n");
    },
  },
});
