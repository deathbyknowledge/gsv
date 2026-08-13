import type {
  MarkdownPreparationRequest,
  MarkdownWorkerResult,
} from "./markdownProtocol";
import { prepareMarkdownBlocks } from "./markdownParser";

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<MarkdownPreparationRequest>) => void) | null;
  postMessage(message: MarkdownWorkerResult): void;
};

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request?.type !== "prepare") return;
  try {
    workerScope.postMessage({
      type: "prepared",
      generation: request.generation,
      blocks: prepareMarkdownBlocks(request.source),
    });
  } catch {
    workerScope.postMessage({
      type: "failed",
      generation: request.generation,
    });
  }
};
