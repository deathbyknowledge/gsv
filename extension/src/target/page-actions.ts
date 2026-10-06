export * from "@humansandmachines/gsv-browser/page-actions";
import { createPageActions } from "@humansandmachines/gsv-browser/page-actions";
import * as debuggerBackend from "../shared/debugger";
import { pageReferences } from "./page-semantics";
export const { clickPageElement, typePageText, sendPageKey, scrollPage } = createPageActions(debuggerBackend, pageReferences);
