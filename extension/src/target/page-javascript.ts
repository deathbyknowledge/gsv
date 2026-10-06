export * from "@humansandmachines/gsv-browser/page-javascript";
import { createPageJavaScript } from "@humansandmachines/gsv-browser/page-javascript";
import * as debuggerBackend from "../shared/debugger";
export const { evaluatePageJavaScript } = createPageJavaScript(debuggerBackend);
