export const REQUEST_CANCEL_SIGNAL = "request.cancel";

export type RequestCancelPayload = {
  id: string;
  reason?: string;
};
