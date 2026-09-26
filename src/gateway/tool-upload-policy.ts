import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isGatewayUploadRequest } from "./upload-policy.js";

/** Only classify byte-bearing commands; ordinary reads and internal transfer owners stay separate. */
export function isNodeUploadRequest(command: string, params: unknown): boolean {
  if (command === "terminal.upload" || command === "browser.proxy.upload.v1") {
    return true;
  }
  return command === "file.write" && isRecord(params) && typeof params.contentBase64 === "string";
}

/** New client bytes, not a request to deliver a file already owned by the Gateway. */
export function isToolUploadRequest(toolName: string, args: unknown): boolean {
  if (!isRecord(args)) {
    return false;
  }
  switch (toolName) {
    case "file_write":
      return typeof args.contentBase64 === "string";
    case "workboard_attachment_add":
      return true;
    case "message":
      return isGatewayUploadRequest("message.action", { params: args });
    default:
      return false;
  }
}
