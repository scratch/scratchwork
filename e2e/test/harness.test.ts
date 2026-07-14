import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Browser, nextPort } from "../src/harness";

describe("browser cookie fidelity", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;

  beforeAll(() => {
    const port = nextPort();
    origin = `http://localhost:${port}`;
    server = Bun.serve({
      port,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/domain") {
          return new Response("ok", { headers: { "set-cookie": "wide=1; Domain=localhost; Path=/" } });
        }
        if (path === "/expire") {
          return new Response("ok", { headers: { "set-cookie": "wide=gone; Domain=localhost; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT" } });
        }
        if (path === "/invalid-host-prefix") {
          return new Response("ok", { headers: { "set-cookie": "__Host-session=bad; Domain=localhost; Path=/" } });
        }
        return new Response("ok");
      },
    });
  });

  afterAll(() => server.stop(true));

  test("honors Domain scope, Expires deletion, and __Host- restrictions", async () => {
    const browser = new Browser();
    await browser.request(`${origin}/domain`);
    expect(browser.cookieHeader(new URL(origin.replace("localhost", "pages.localhost")))).toContain("wide=1");

    await browser.request(`${origin}/invalid-host-prefix`);
    expect(browser.getCookie("localhost", "__Host-session")).toBeUndefined();

    await browser.request(`${origin}/expire`);
    expect(browser.getCookie("localhost", "wide")).toBeUndefined();
    expect(browser.cookieHeader(new URL(origin.replace("localhost", "pages.localhost")))).not.toContain("wide=");
  });
});
