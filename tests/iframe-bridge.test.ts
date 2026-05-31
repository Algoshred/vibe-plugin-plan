/**
 * Tests for the generic plan iframe-bridge.
 *
 * Architecture rule (per repo guideline): the agent NEVER knows about a
 * specific plan provider. The meta plugin owns the iframe-ticket -> cookie
 * bridge, and the provider's reverse proxy is a black box behind a
 * forwarder. These tests use a fake forwarder that authenticates exactly
 * like the real plannotator proxy (`x-agent-api-key` / `?apiKey=` / its
 * own session cookie) so we exercise the bridge end-to-end without
 * loading the provider.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";

import type { HostServices } from "@vibecontrols/plugin-sdk";

import {
  handlePlanProxyRequest,
  renderPlanBootstrapHtml,
  type PlanProxyForwarder,
} from "../src/lib/iframe-bridge.js";

const SID = "50d2398a-034c-417a-8f01-5001da39410c"; // UUID style
const COOKIE_SAFE_SID = "abc-123"; // matches lowercase-alnum-hyphen
const TUNNEL = "https://tunnel.example.com";
const AGENT_KEY = "vcak_plan_proxy_test_key";
// Stand-in for the plannotator proxy's own session cookie name (the bridge
// must NOT know the real one - it relies on the forwarder's 200/401 verdict).
const PROXY_COOKIE = "plannotator_session";

// ── Tiny in-memory iframe-bridge fake ──────────────────────────────────
//
// Mirrors the agent's iframe-tokens.ts wire format closely enough for the
// bridge to round-trip. The actual agent runtime supplies the real
// implementation via HostServices.iframeBridge.

const FAKE_SECRET = randomBytes(32);
const consumed = new Set<string>();

function signIframe(prefix: string, exp: string, nonce: string): string {
  return createHmac("sha256", FAKE_SECRET)
    .update(`${prefix}\n${exp}\n${nonce}`)
    .digest("hex");
}

function issueFakeIframeToken(prefix: string, ttlMs = 600_000): string {
  const exp = new Date(Date.now() + ttlMs).toISOString();
  const nonce = randomBytes(16).toString("hex");
  const mac = signIframe(prefix, exp, nonce);
  return `${exp}|${nonce}|${mac}`;
}

function signUi(plugin: string, exp: string, nonce: string): string {
  return createHmac("sha256", FAKE_SECRET)
    .update(`uc1\n${plugin}\n${exp}\n${nonce}`)
    .digest("hex");
}

function issueFakeUiCookie(sid: string, ttlMs = 600_000): string {
  const exp = new Date(Date.now() + ttlMs).toISOString();
  const nonce = randomBytes(16).toString("hex");
  const mac = signUi(sid, exp, nonce);
  return `uc1|${exp}|${sid}|${nonce}|${mac}`;
}

function makeFakeBridge(): NonNullable<HostServices["iframeBridge"]> {
  return {
    getAgentApiKey: () => AGENT_KEY,
    verifyIframeToken: (token: string, expectedPath: string): boolean => {
      const parts = token.split("|");
      if (parts.length !== 3) return false;
      const [exp, nonce, mac] = parts;
      if (!exp || !nonce || !mac) return false;
      if (Date.parse(exp) <= Date.now()) return false;
      // Walk progressive prefixes to recover the bound one.
      const segs = expectedPath.split("/").filter(Boolean);
      const candidates = ["/"];
      let acc = "";
      for (const s of segs) {
        acc += `/${s}`;
        candidates.push(acc);
      }
      for (const c of candidates) {
        const want = signIframe(c, exp, nonce);
        if (want === mac) {
          if (!expectedPath.startsWith(c)) return false;
          if (consumed.has(nonce)) return false;
          consumed.add(nonce);
          return true;
        }
      }
      return false;
    },
    verifyUiCookieToken: (token: string, sid: string): boolean => {
      if (!token.startsWith("uc1|")) return false;
      const parts = token.slice(4).split("|");
      if (parts.length !== 4) return false;
      const [exp, embeddedSid, nonce, mac] = parts;
      if (!exp || !embeddedSid || !nonce || !mac) return false;
      if (embeddedSid !== sid) return false;
      if (Date.parse(exp) <= Date.now()) return false;
      return signUi(embeddedSid, exp, nonce) === mac;
    },
    issueUiCookieToken: (sid: string, ttlSeconds: number) => {
      const token = issueFakeUiCookie(sid, ttlSeconds * 1000);
      const exp = token.split("|")[1] ?? "";
      return { token, expiresAt: Date.parse(exp) };
    },
    getIframeTokenFromRequest: (req: Request): string | null => {
      const hdr =
        req.headers.get("x-vibe-iframe-token") ??
        req.headers.get("X-Vibe-Iframe-Token");
      if (hdr) return hdr;
      try {
        return new URL(req.url).searchParams.get("vt");
      } catch {
        return null;
      }
    },
    getUiCookieFromRequest: (req: Request, sid: string): string | null => {
      const c = req.headers.get("cookie") ?? "";
      const name = `vt_ui_${sid}`;
      for (const raw of c.split(";")) {
        const i = raw.indexOf("=");
        if (i === -1) continue;
        if (raw.slice(0, i).trim() === name) return raw.slice(i + 1).trim();
      }
      return null;
    },
    isValidUiPluginName: (sid: unknown): sid is string =>
      typeof sid === "string" && /^[a-z0-9-]{1,64}$/.test(sid),
    frameAncestorsCsp: () => "frame-ancestors 'self' https://vibecontrols.com",
  };
}

function makeHost(): HostServices {
  return { iframeBridge: makeFakeBridge() };
}

// Forwarder mocks the plan provider's proxy: authenticated requests get
// 200, otherwise 401. Records every forwarded request.
function makeForwarder() {
  const calls: Request[] = [];
  const forwarder: PlanProxyForwarder = {
    handle: async (req: Request): Promise<Response> => {
      calls.push(req);
      const u = new URL(req.url);
      const authed =
        req.headers.get("x-agent-api-key") != null ||
        u.searchParams.get("apiKey") != null ||
        (req.headers.get("cookie") ?? "").includes(`${PROXY_COOKIE}=`);
      return authed
        ? new Response("upstream-ok", { status: 200 })
        : new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
          });
    },
  };
  return { calls, forwarder };
}

const isBootstrap = (res: Response) =>
  (res.headers.get("content-type") ?? "").includes("text/html");

describe("handlePlanProxyRequest (meta-plugin generic bridge)", () => {
  beforeEach(() => consumed.clear());
  afterEach(() => consumed.clear());

  it("serves the bootstrap when the provider rejects the initial doc GET", async () => {
    const { forwarder } = makeForwarder();
    const res = await handlePlanProxyRequest(
      new Request(`${TUNNEL}/plan/${SID}/`, {
        headers: { accept: "text/html", "sec-fetch-dest": "iframe" },
      }),
      makeHost(),
      forwarder,
    );
    expect(res.status).toBe(200);
    expect(isBootstrap(res)).toBe(true);
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors",
    );
    const html = await res.text();
    expect(html).toContain("location.hash");
    expect(html).toContain('searchParams.set("vt"');
    expect(html).toContain("location.replace");
  });

  it("verifies a ?vt= ticket, injects the key, strips vt, and plants a scoped cookie for cookie-safe sids", async () => {
    const { calls, forwarder } = makeForwarder();
    const token = issueFakeIframeToken(`/plan/${COOKIE_SAFE_SID}`);
    const res = await handlePlanProxyRequest(
      new Request(
        `${TUNNEL}/plan/${COOKIE_SAFE_SID}/?vt=${encodeURIComponent(token)}`,
        {
          headers: { accept: "text/html", "sec-fetch-dest": "iframe" },
        },
      ),
      makeHost(),
      forwarder,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
    expect(calls.length).toBe(1);
    expect(calls[0]!.headers.get("x-agent-api-key")).toBe(AGENT_KEY);
    expect(new URL(calls[0]!.url).searchParams.get("vt")).toBeNull();
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`vt_ui_${COOKIE_SAFE_SID}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).toContain(`Path=/plan/${COOKIE_SAFE_SID}/`);
  });

  it("accepts the planted plan cookie on a follow-up sub-request and injects the key", async () => {
    const { calls, forwarder } = makeForwarder();
    const cookieToken = issueFakeUiCookie(COOKIE_SAFE_SID);
    const res = await handlePlanProxyRequest(
      new Request(`${TUNNEL}/plan/${COOKIE_SAFE_SID}/assets/app.js`, {
        headers: {
          cookie: `vt_ui_${COOKIE_SAFE_SID}=${cookieToken}`,
          accept: "*/*",
        },
      }),
      makeHost(),
      forwarder,
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.headers.get("x-agent-api-key")).toBe(AGENT_KEY);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("returns the provider's 401 untouched for an unauthenticated ASSET (no bootstrap)", async () => {
    const { calls, forwarder } = makeForwarder();
    const res = await handlePlanProxyRequest(
      new Request(`${TUNNEL}/plan/${SID}/assets/app.js`, {
        headers: { accept: "*/*" },
      }),
      makeHost(),
      forwarder,
    );
    expect(res.status).toBe(401);
    expect(isBootstrap(res)).toBe(false);
    expect(calls.length).toBe(1);
    expect(calls[0]!.headers.get("x-agent-api-key")).toBeNull();
  });

  it("preserves the provider's native ?apiKey= doc-nav entry path", async () => {
    const { calls, forwarder } = makeForwarder();
    const res = await handlePlanProxyRequest(
      new Request(`${TUNNEL}/plan/${SID}/?apiKey=vcak_direct`, {
        headers: { accept: "text/html", "sec-fetch-dest": "iframe" },
      }),
      makeHost(),
      forwarder,
    );
    expect(await res.text()).toBe("upstream-ok");
    expect(isBootstrap(res)).toBe(false);
    expect(new URL(calls[0]!.url).searchParams.get("apiKey")).toBe(
      "vcak_direct",
    );
  });

  it("forwards a doc nav bearing the provider's own session cookie (no bootstrap)", async () => {
    // Bridge MUST be agnostic to the provider's cookie name - it relies on
    // the 200/401 verdict.
    const { forwarder } = makeForwarder();
    const res = await handlePlanProxyRequest(
      new Request(`${TUNNEL}/plan/${SID}/`, {
        headers: {
          accept: "text/html",
          "sec-fetch-dest": "iframe",
          cookie: `${PROXY_COOKIE}=stillvalid`,
        },
      }),
      makeHost(),
      forwarder,
    );
    expect(await res.text()).toBe("upstream-ok");
    expect(isBootstrap(res)).toBe(false);
  });

  it("rejects a REPLAYED ticket (single-use) - second use falls through to bootstrap", async () => {
    const { forwarder } = makeForwarder();
    const token = issueFakeIframeToken(`/plan/${COOKIE_SAFE_SID}`);
    const mk = () =>
      new Request(
        `${TUNNEL}/plan/${COOKIE_SAFE_SID}/?vt=${encodeURIComponent(token)}`,
        {
          headers: { accept: "text/html", "sec-fetch-dest": "iframe" },
        },
      );
    const host = makeHost();
    const first = await handlePlanProxyRequest(mk(), host, forwarder);
    expect(await first.text()).toBe("upstream-ok");
    const second = await handlePlanProxyRequest(mk(), host, forwarder);
    expect(isBootstrap(second)).toBe(true);
  });

  it("forwards a POST body to the provider when authenticated via the plan cookie", async () => {
    const { calls, forwarder } = makeForwarder();
    const cookieToken = issueFakeUiCookie(COOKIE_SAFE_SID);
    const payload = JSON.stringify({ note: "hi" });
    const res = await handlePlanProxyRequest(
      new Request(`${TUNNEL}/plan/${COOKIE_SAFE_SID}/api/annotate`, {
        method: "POST",
        headers: {
          cookie: `vt_ui_${COOKIE_SAFE_SID}=${cookieToken}`,
          "content-type": "application/json",
        },
        body: payload,
      }),
      makeHost(),
      forwarder,
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("x-agent-api-key")).toBe(AGENT_KEY);
    expect(await calls[0]!.text()).toBe(payload);
  });

  it("sets no-store + nosniff on the bootstrap so it can't be cached and served stale", async () => {
    const { forwarder } = makeForwarder();
    const res = await handlePlanProxyRequest(
      new Request(`${TUNNEL}/plan/${SID}/`, {
        headers: { accept: "text/html", "sec-fetch-dest": "iframe" },
      }),
      makeHost(),
      forwarder,
    );
    expect(isBootstrap(res)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("handles a non-cookie-safe sid: verifies the ticket but plants NO cookie", async () => {
    // `weird.session` fails the cookie-name charset (dot) so the bridge
    // skips the cookie plant - but the ticket still authenticates.
    const badSid = "weird.session";
    const { calls, forwarder } = makeForwarder();
    const token = issueFakeIframeToken(`/plan/${badSid}`);
    const res = await handlePlanProxyRequest(
      new Request(`${TUNNEL}/plan/${badSid}/?vt=${encodeURIComponent(token)}`, {
        headers: { accept: "text/html", "sec-fetch-dest": "iframe" },
      }),
      makeHost(),
      forwarder,
    );
    expect(await res.text()).toBe("upstream-ok");
    expect(calls.length).toBe(1);
    expect(calls[0]!.headers.get("x-agent-api-key")).toBe(AGENT_KEY);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("renderPlanBootstrapHtml emits a self-contained fragment-exchange doc", () => {
    const html = renderPlanBootstrapHtml();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("location.hash");
    expect(html).toContain('u.searchParams.set("vt"');
  });

  it("forwards untouched when the host doesn't expose iframeBridge (older agent)", async () => {
    const { calls, forwarder } = makeForwarder();
    const res = await handlePlanProxyRequest(
      new Request(`${TUNNEL}/plan/${SID}/?apiKey=vcak_direct`, {
        headers: { accept: "text/html", "sec-fetch-dest": "iframe" },
      }),
      {} as HostServices,
      forwarder,
    );
    expect(await res.text()).toBe("upstream-ok");
    expect(calls.length).toBe(1);
  });
});
