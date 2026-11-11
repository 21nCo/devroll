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
  | {
    readonly allowed: false;
    readonly status: number;
    readonly error: string;
    /** Headers the refusal needs, such as `Allow` on a `405`. */
    readonly headers?: Readonly<Record<string, string>>;
  };

/** What the config endpoint needs to know about the dev server. */
export interface ConfigRequestContext {
  /** Whether the dev server itself speaks TLS (`server.https`). */
  readonly https: boolean;
  /** Every origin the dev server's pages may use, loopback aliases included. */
  readonly allowedOrigins: readonly string[];
  /**
   * The origins set in the config (`server.origin`, the `origins` option). For one of these with `https`, a plain
   * HTTP request with the same host is accepted too: TLS ends at a proxy or tunnel in front of the dev server.
   */
  readonly configuredOrigins: readonly string[];
}

const FORBIDDEN = "Only the dev server's own pages may read the Iterbar config";

/** A bare `host[:port]`: no user info, path, query, fragment, backslash or white space for a URL parser to drop. */
const BARE_AUTHORITY = /^[^@/\\?#\s]+$/;

/**
 * The host the request was sent to: `Host` in HTTP/1.1, the `:authority` pseudo-header in HTTP/2. `undefined` when
 * missing or not a bare `host[:port]`, so `user@127.0.0.1:5173` or `127.0.0.1:5173/x` never passes as a loopback host.
 */
function requestAuthority(request: IncomingMessage): string | undefined {
  const pseudo = request.headers[":authority"];
  const authority = typeof pseudo === "string" && pseudo !== "" ? pseudo : request.headers.host;
  return authority !== undefined && BARE_AUTHORITY.test(authority) ? authority : undefined;
}

/**
 * The origins the page that sent the request may have: the dev server's own scheme with the request's host, and on
 * a plain HTTP server also `https` with that host when the config names that origin. Empty for a missing or invalid
 * host.
 */
function candidateOrigins(request: IncomingMessage, context: ConfigRequestContext): string[] {
  const authority = requestAuthority(request);
  if (authority === undefined) return [];
  const own = originOf(`${context.https ? "https" : "http"}://${authority}`);
  if (own === null) return [];
  const candidates = [own];
  if (!context.https) {
    const behindTls = originOf(`https://${authority}`);
    if (behindTls !== null && context.configuredOrigins.includes(behindTls)) candidates.push(behindTls);
  }
  return candidates;
}

/**
 * Decides whether a request may read the token. Only a page of the dev server itself may: the request must be a
 * `GET` from the same origin (`Sec-Fetch-Site`, and `Origin` when a browser sends one), and that origin must be one
 * the daemon allows. A page of another site, or one reaching the server under another host name (DNS rebinding),
 * gets nothing. This check runs whether or not Vite checks the host itself, which it does not on an HTTPS server
 * or with `allowedHosts: true`.
 */
export function checkConfigRequest(request: IncomingMessage, context: ConfigRequestContext): ConfigRequestCheck {
  if (request.method !== "GET") {
    return { allowed: false, status: 405, error: "Only GET is allowed", headers: { allow: "GET" } };
  }
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") {
    return { allowed: false, status: 403, error: FORBIDDEN };
  }
  const candidates = candidateOrigins(request, context);
  const sent = request.headers.origin;
  // A browser that sends Origin names the page's origin exactly; it must be one the request's host can have.
  const possible = sent === undefined ? candidates : candidates.filter((origin) => origin === sent);
  if (possible.length === 0) {
    return { allowed: false, status: 403, error: FORBIDDEN };
  }
  const origin = possible.find((each) => context.allowedOrigins.includes(each));
  if (origin === undefined) {
    return {
      allowed: false,
      status: 403,
      error: `${possible[0]} is not an origin of this dev server; add it to iterbar({ origins }) or set server.origin`,
    };
  }
  return { allowed: true, origin };
}

/** Sends a JSON answer that no cache keeps and no browser sniffs as another type. */
export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}
