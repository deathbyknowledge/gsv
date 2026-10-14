import type { RequestFrame, ResponseFrame } from "../protocol/frames";

export function rejectBeforeDispatch(frame: RequestFrame, code: number, message: string): ResponseFrame {
  const response: ResponseFrame = { type: "res", id: frame.id, ok: false, error: { code, message } };
  if (frame.call === "shell.exec" && frame.args.start === true) {
    response.error.details = { shellStart: "rejected" };
  }
  return response;
}
