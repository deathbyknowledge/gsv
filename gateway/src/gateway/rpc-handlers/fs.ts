import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";

export const handleFsAuthorize: Handler<"fs.authorize"> = ({ gw, params }) => {
  if (!params?.pathPrefix || typeof params.pathPrefix !== "string") {
    throw new RpcError(400, "pathPrefix is required");
  }
  if (params.mode !== "read" && params.mode !== "write") {
    throw new RpcError(400, "mode must be 'read' or 'write'");
  }

  // Sanitize: no path traversal, no leading slash
  const cleaned = params.pathPrefix.replace(/^\/+/, "").replace(/\.\.\//g, "");
  if (!cleaned) {
    throw new RpcError(400, "pathPrefix is empty after sanitization");
  }

  return gw.authorizeFs(cleaned, params.mode);
};
