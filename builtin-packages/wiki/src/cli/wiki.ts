import { defineCommand } from "@humansandmachines/gsv/sdk/cli";
import { runWikiCommand } from "./wiki-runner";

export default defineCommand(async (ctx) => {
  await ctx.stdout.write(await runWikiCommand(ctx));
});
