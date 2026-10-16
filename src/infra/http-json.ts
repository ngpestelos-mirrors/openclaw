import type { ServerResponse } from "node:http";

/** Send a UTF-8 JSON response, preserving headers set by the route owner. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
