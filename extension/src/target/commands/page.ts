export * from "@humansandmachines/gsv-browser/commands/page";
import { createPageCommands } from "@humansandmachines/gsv-browser/commands/page";
import * as browserBackend from "../../shared/chrome";
import * as debuggerBackend from "../../shared/debugger";
import { pageReferences } from "../page-semantics";
export const { pageCommand, pageCommands } = createPageCommands(browserBackend, debuggerBackend, pageReferences);
export default pageCommand;
