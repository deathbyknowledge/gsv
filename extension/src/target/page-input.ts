export * from "@humansandmachines/gsv-browser/page-input";
import { createPageInput } from "@humansandmachines/gsv-browser/page-input";
import { sendDebuggerCommand } from "../shared/debugger";
export const { readPageScrollState, viewportCenter } = createPageInput(sendDebuggerCommand);
