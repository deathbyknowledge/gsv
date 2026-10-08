export * from "@humansandmachines/gsv-browser/page-semantics";
import { createPageSemantics, PageReferenceStore } from "@humansandmachines/gsv-browser/page-semantics";
import { sendDebuggerCommand } from "../shared/debugger";
export const pageReferences = new PageReferenceStore();
export const { captureSemanticSnapshot, currentDocumentIdentity } = createPageSemantics(sendDebuggerCommand, pageReferences);
