import type { IncomingMessage, ServerResponse } from "node:http";
import { originOf } from "./origins.js";

/** The dev server path, below Vite's `base`, that hands the bar its daemon URL and token. */
export const CONFIG_PATH = "__iterbar/config";

/** The answer of the config endpoint. */
export interface BarConfigResponse {
  readonly daemonUrl: string;
  readonly token: string;
}

export type ConfigRequestCheck =
  | { readonly allowed: true; readonly origin: string }
  | { readonly allowed: false; readonly status: number; readonly error: string };

/**
 * Decides whether a request may read the token. Only a page of the dev server itself may: the request must be a
 * `GET` from the same origin (`Sec-Fetch-Site`, and `Origin` when a browser sends one), and that origin must be one
 * the daemon allows. A page of another site, or one reaching the server under another host name (DNS rebinding),
 * gets nothing, and Vite's own host check has already run.
 */
export function checkConfigRequest(request: IncomingMessage, https: boolean, allowedOrigins: readonly string[]): ConfigRequestCheck {
  if (request.method !== "GET") {
    return { allowed: false, status: 405, error: "Only GET is allowed" };
  }
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") {
    return { allowed: false, status: 403, error: "Only the dev server's own pages may read the Iterbar config" };
  }
  const origin = originOf(`${https ? "https" : "http"}://${request.headers.host ?? ""}`);
  if (origin === null || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
    return { allowed: false, status: 403, error: "Only the dev server's own pages may read the Iterbar config" };
  }
  if (!allowedOrigins.includes(origin)) {
    return {
      allowed: false,
      status: 403,
      error: `${origin} is not an origin of this dev server; add it to iterbar({ origins }) or set server.origin`,
    };
  }
  return { allowed: true, origin };
}

/** Sends a JSON answer that no cache keeps and no browser sniffs as another type. */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}
