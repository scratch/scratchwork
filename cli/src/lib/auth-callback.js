/*
 * The localhost callback listener for browser-based login. After the user
 * approves in the browser, the server 302s the session token to
 * http://localhost:8400/callback?token=…&state=…[&cf_token=…]; this captures it.
 *
 * The `state` echoed back MUST match the value we generated, or we reject and
 * keep listening — that's the CSRF defense for the loopback handoff. Uses
 * Bun.serve (the same primitive the dev server uses); zero dependencies.
 */

// MUST match the server (server/src/lib/url-helpers.js LOCALHOST_CALLBACK_PORT).
export const LOCALHOST_CALLBACK_PORT = 8400;

export function generateCallbackState() {
  return crypto.randomUUID();
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateCliCode(len = 6) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function pageOK() {
  return `<!doctype html><meta charset=utf-8><title>Logged in</title><style>body{font:16px/1.6 -apple-system,sans-serif;max-width:28rem;margin:5rem auto;padding:0 1rem;text-align:center}</style><h1>You're logged in</h1><p>You can close this tab and return to your terminal.</p>`;
}
function pageErr(msg) {
  return `<!doctype html><meta charset=utf-8><title>Login error</title><style>body{font:16px/1.6 -apple-system,sans-serif;max-width:28rem;margin:5rem auto;padding:0 1rem;text-align:center}</style><h1>Login problem</h1><p>${String(msg).replace(/[<>&]/g, "")}</p>`;
}

/**
 * Listen on `port` for the callback. Resolves { token, cfToken? } once a request
 * with the expected state and a token arrives; rejects on error/timeout.
 */
export function waitForCallback(port, expectedState, timeoutMs) {
  return new Promise((resolve, reject) => {
    let server;
    let timer;
    // Settle the promise NOW, but stop the server a moment later so the current
    // HTTP response flushes to the browser before the socket closes (a force
    // stop here would reset the connection mid-response).
    const done = (fn, arg) => {
      clearTimeout(timer);
      fn(arg);
      setTimeout(() => {
        try {
          server && server.stop();
        } catch {
          /* ignore */
        }
      }, 100);
    };

    try {
      server = Bun.serve({
        port,
        idleTimeout: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname !== "/callback") {
            return new Response(pageErr("Not found"), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
          }
          const state = url.searchParams.get("state");
          const token = url.searchParams.get("token");
          const cfToken = url.searchParams.get("cf_token");
          const error = url.searchParams.get("error");

          // CSRF guard FIRST: any callback whose state doesn't match ours (incl.
          // a spurious ?error= from a page the user merely visited) is rejected
          // but we keep listening, so it can't abort the real login attempt.
          if (state !== expectedState) {
            return new Response(pageErr("Invalid state. Please try logging in again."), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
          }
          if (error) {
            done(reject, new Error(error));
            return new Response(pageErr(error), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
          }
          if (!token) {
            return new Response(pageErr("Missing token. Please try logging in again."), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
          }
          done(resolve, { token, cfToken: cfToken || undefined });
          return new Response(pageOK(), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
        },
      });
    } catch (err) {
      if (String(err?.message || err).includes("EADDRINUSE") || String(err).includes("in use")) {
        reject(new Error(`Port ${port} is already in use. Close whatever is using it and try again.`));
      } else {
        reject(err);
      }
      return;
    }

    timer = setTimeout(() => done(reject, new Error("Login timed out. Please try again.")), timeoutMs);
  });
}
