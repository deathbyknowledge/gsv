export * from "@humansandmachines/gsv-browser/page-observation";
import { createPageObservation } from "@humansandmachines/gsv-browser/page-observation";
import { sendDebuggerCommand } from "../shared/debugger";
export const { beginPageObservation, endPageObservation, summarizeActionObservation, pageDocumentChanged } = createPageObservation(sendDebuggerCommand);
