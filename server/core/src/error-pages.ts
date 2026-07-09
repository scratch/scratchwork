/**
 * Browser-facing HTML error pages, styled to match the renderer's look (white page,
 * system font stack, the prose.css gray palette, the figure mascot). API clients and
 * non-navigation requests keep the standard `{ error }` JSON — `errorResponse` picks
 * the shape per request, so the wire contract for tools like the CLI never changes.
 */
import type * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import FIGURE_SVG from "../../../shared/assets/figure.svg" with { type: "text" };
import { errorJson, securityHeaders } from "./http";

/** One link rendered as a button on an error page. */
export interface ErrorPageAction {
  readonly label: string;
  readonly href: string;
  readonly primary?: boolean;
}

/** Content of one rendered error page. All strings are treated as text and escaped. */
export interface ErrorPage {
  readonly status: number;
  readonly title: string;
  readonly message: string;
  /** Secondary line under the message, e.g. the signed-in account. */
  readonly note?: string;
  readonly actions?: readonly ErrorPageAction[];
}

/** True when the request is a browser page navigation that should get an HTML error
 * page: a GET/HEAD outside /api/ whose Accept header asks for text/html. Everything
 * else (CLI, fetch, curl, API routes) keeps the JSON error shape. */
export function acceptsHtmlPage(
  request: HttpServerRequest.HttpServerRequest,
): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = new URL(request.url, "http://scratchwork.local").pathname;
  if (pathname === "/api" || pathname.startsWith("/api/")) return false;
  const accept = request.headers.accept;
  return accept != null && accept.toLowerCase().includes("text/html");
}

/** Renders a caught error as an HTML page for browser navigations, JSON otherwise. */
export function errorResponse(
  request: HttpServerRequest.HttpServerRequest,
  status: number,
  message: string,
): HttpServerResponse.HttpServerResponse {
  if (!acceptsHtmlPage(request)) return errorJson(status, message);
  return errorPageResponse(genericErrorPage(status, message));
}

/** Builds the HTML response for one error page. */
export function errorPageResponse(
  page: ErrorPage,
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text(errorPageHtml(page), {
    status: page.status,
    contentType: "text/html; charset=utf-8",
    headers: securityHeaders(),
  });
}

/** Maps an error status to friendly page copy. 4xx messages are crafted for clients
 * (the JSON error path already sends them verbatim) and shown as-is; on 401/403 pages
 * the specific reason appears as the note under the friendly copy, so an auth
 * misconfiguration (say, a Cloudflare Access AUD mismatch) is diagnosable from the page
 * itself. 5xx details stay out of the page (they can carry internals). */
function genericErrorPage(status: number, message: string): ErrorPage {
  if (status === 401) {
    return {
      status,
      title: "Sign-in required",
      message: "You need to sign in to view this page.",
      note: message === "" ? undefined : message,
    };
  }
  if (status === 403) {
    return {
      status,
      title: "Access denied",
      message: "You don't have access to this page.",
      note: message === "" ? undefined : message,
    };
  }
  if (status === 404) {
    return {
      status,
      title: "Page not found",
      message:
        "There's nothing at this address. It may have been unpublished, or the link may be wrong.",
    };
  }
  if (status < 500) {
    return { status, title: "Something's not right", message };
  }
  return {
    status,
    title: "Something went wrong",
    message: "The server hit an unexpected error. Try again in a moment.",
  };
}

/** Escapes text for interpolation into HTML content and attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    char === "&"
      ? "&amp;"
      : char === "<"
        ? "&lt;"
        : char === ">"
          ? "&gt;"
          : char === '"'
            ? "&quot;"
            : "&#39;",
  );
}

/** Renders the full HTML document for one error page. */
export function errorPageHtml(page: ErrorPage): string {
  const note =
    page.note == null
      ? ""
      : `\n      <p class="note">${escapeHtml(page.note)}</p>`;
  const actions =
    page.actions == null || page.actions.length === 0
      ? ""
      : `\n      <div class="actions">${page.actions
          .map(
            (action) =>
              `<a class="button ${action.primary === true ? "primary" : "secondary"}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`,
          )
          .join("")}</div>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(page.title)} · scratchwork</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FIGURE_SVG)}" />
    <style>
      :root {
        --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
          Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
        --gray-100: #f3f4f6;
        --gray-200: #e5e7eb;
        --gray-400: #9ca3af;
        --gray-500: #6b7280;
        --gray-700: #374151;
        --gray-900: #111827;
      }
      * { box-sizing: border-box; }
      html { -webkit-text-size-adjust: 100%; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #fff;
        color: var(--gray-700);
        font-family: var(--font-sans);
        font-size: 1rem;
        line-height: 1.6;
      }
      main {
        max-width: 26rem;
        padding: 3rem 1.5rem;
        text-align: center;
      }
      .figure { width: 6.5rem; margin: 0 auto 1.5rem; }
      .figure svg { display: block; width: 100%; height: auto; }
      h1 {
        margin: 0 0 0.5em;
        font-size: 1.4em;
        font-weight: 700;
        line-height: 1.3;
        color: var(--gray-900);
        text-wrap: balance;
      }
      p { margin: 0.5em 0; }
      .note { color: var(--gray-500); font-size: 0.875em; }
      .actions {
        margin-top: 1.75rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        align-items: center;
      }
      .button {
        display: inline-block;
        border-radius: 0.5rem;
        padding: 0.5rem 1rem;
        font-size: 0.9375rem;
        font-weight: 500;
        text-decoration: none;
        transition: background 150ms ease, color 150ms ease;
      }
      .button.primary { background: var(--gray-900); color: #fff; }
      .button.primary:hover { background: var(--gray-700); }
      .button.secondary { background: var(--gray-100); color: var(--gray-700); }
      .button.secondary:hover { background: var(--gray-200); }
      .button:focus-visible { outline: 2px solid var(--gray-400); outline-offset: 2px; }
    </style>
  </head>
  <body>
    <main>
      <div class="figure">${FIGURE_SVG.trim()}</div>
      <h1>${escapeHtml(page.title)}</h1>
      <p>${escapeHtml(page.message)}</p>${note}${actions}
    </main>
  </body>
</html>
`;
}
