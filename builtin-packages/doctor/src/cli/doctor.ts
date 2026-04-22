import { defineCommand } from "@gsv/package/cli";

export default defineCommand(async (ctx) => {
  await ctx.stdout.write("gsv doctor: status checks are not implemented yet\n");
});
