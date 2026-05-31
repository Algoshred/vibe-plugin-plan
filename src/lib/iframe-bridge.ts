/**
 * Generic iframe-ticket -> cookie auth-bridge for the plan meta plugin.
 *
 * The plan workbench mounts an iframe at `${tunnel}/plan/<sid>/#vt=<ticket>`.
 * Two facts collide:
 *   - the active plan PROVIDER's reverse proxy (whichever plugin the agent
 *     resolves under the `"plan"` provider type) authenticates a caller via
 *     `x-agent-api-key` / `?apiKey=` / its own session cookie - it does NOT
 *     understand the host's short-lived iframe tickets; and
 *   - the browser can't carry the long-lived agent api key, and the ticket
 *     lives in the URL fragment (`#vt`), which is never sent to the server.
 *
 * `handlePlanProxyRequest` bridges them, mirroring the proven `/ui/<plugin>`
 * bootstrap + the code-server proxy's direct-Set-Cookie approach.
 *
 * Architecture rule (per repo guideline):
 *   - the agent NEVER knows about a specific provider (plannotator). Its
 *     `/plan/*` route is a blind `pluginRoutesApp.handle(request)` delegator.
 *   - the meta plugin owns the generic bridge route + dispatches to the
 *     active provider via `PlanProvider.proxyRequest`.
 *   - the provider owns the actual reverse-proxy logic (per-session port,
 *     header/cookie scrubbing, SSE pass-through) and has zero knowledge
 *     of iframe tickets.
 *
 * All iframe-token + UI-cookie + frame-ancestors primitives come from the
 * SDK's `HostServices.iframeBridge` namespace - the meta plugin never
 * imports agent internals.
 */

import type { HostServices } from "@vibecontrols/plugin-sdk";

import type { PlanProvider } from "../types.js";

// Lifetime of the scoped plan cookie. Used for BOTH the HMAC token's signed
// expiry (issueUiCookieToken) and the browser cookie's Max-Age - keep them
// in one place so they can't diverge. Matches the iframe-token TTL cap (600s).
const PLAN_COOKIE_TTL_S = 600;

/**
 * Tiny bootstrap document served for the plan iframe's initial navigation.
 *
 * The `#vt` ticket lives in the URL fragment, which the browser never sends
 * to the server - so the very first GET arrives with no credential and would
 * 401 at the provider's proxy. This bootstrap runs client-side, lifts the
 * ticket out of the fragment, and re-requests the same path with
 * `?vt=<ticket>` as a query param the meta plugin CAN see and verify.
 */
export function renderPlanBootstrapHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Plan</title></head>
<body><script>
(function(){
  try{
    var h = String(window.location.hash || "");
    var m = h.match(/(?:^#|[#&])vt=([^&]*)/);
    if(!m){document.body.textContent="Missing plan iframe token.";return;}
    var u = new URL(window.location.href);
    u.hash = "";
    u.searchParams.set("vt", decodeURIComponent(m[1]));
    window.location.replace(u.toString());
  }catch(e){document.body.textContent="Plan bootstrap failed.";}
})();
</script></body></html>`;
}

/**
 * Minimal forwarder shape - abstracts away whether the caller routes
 * through Elysia, a direct provider call, or a test stub. The bridge
 * never touches Elysia / agent internals.
 */
export interface PlanProxyForwarder {
  handle: (req: Request) => Response | Promise<Response>;
}

/**
 * Bridge an iframe request for `/plan/<sid>/*` to the active plan provider.
 *
 *  1. A request already bearing OUR scoped plan cookie (`vt_ui_<sid>`, set
 *     in step 2) -> inject `x-agent-api-key` server-side and forward.
 *  2. A request bearing a valid `?vt=` / `x-vibe-iframe-token` ticket
 *     scoped to `/plan/<sid>` -> forward with the key injected AND attach
 *     a scoped `vt_ui_<sid>` cookie (SameSite=None; Secure - cross-site
 *     iframe).
 *  3. A top-level document navigation with no credential yet -> serve the
 *     bootstrap that lifts `#vt` out of the fragment into `?vt=` (step 2).
 *  4. Anything else -> forward untouched (the provider's proxy 401s it).
 *
 * The injected key never reaches the browser; the ticket in the URL is the
 * short-lived single-use HMAC one, not the agent key.
 *
 * Provider-agnostic: the bridge has zero knowledge of the upstream's own
 * session-cookie name. It relies on the provider's 200/401 verdict.
 */
export async function handlePlanProxyRequest(
  request: Request,
  host: HostServices,
  forwarder: PlanProxyForwarder,
): Promise<Response> {
  const bridge = host.iframeBridge;
  if (!bridge) {
    // Older agent without the iframe-bridge surface - forward untouched.
    // Provider's own `?apiKey=` / cookie entry paths still work, but the
    // fragment-ticket bootstrap is unavailable.
    return forwarder.handle(request);
  }

  const url = new URL(request.url);
  const sidMatch = /^\/plan\/([^/]+)/.exec(url.pathname);
  const sid = sidMatch?.[1] ?? null;
  // Only sids that fit the cookie-name charset get the cookie fast-path -
  // keeps the Set-Cookie name/Path free of injection.
  const cookieSafeSid = sid && bridge.isValidUiPluginName(sid) ? sid : null;
  const sessionPrefix = sid ? `/plan/${sid}` : null;

  const forwardWithKey = async (req: Request): Promise<Response> => {
    const fwdUrl = new URL(req.url);
    fwdUrl.searchParams.delete("vt");
    const headers = new Headers(req.headers);
    headers.set("x-agent-api-key", bridge.getAgentApiKey());
    headers.delete("x-vibe-iframe-token");
    const body =
      req.method !== "GET" && req.method !== "HEAD"
        ? await req.arrayBuffer()
        : undefined;
    return forwarder.handle(
      new Request(fwdUrl.toString(), { method: req.method, headers, body }),
    );
  };

  // 1) Established plan session cookie -> forward with the key injected.
  if (cookieSafeSid) {
    const cookieTok = bridge.getUiCookieFromRequest(request, cookieSafeSid);
    if (cookieTok && bridge.verifyUiCookieToken(cookieTok, cookieSafeSid)) {
      return forwardWithKey(request);
    }
  }

  // 2) Valid iframe ticket -> forward + plant a scoped plan cookie.
  if (sessionPrefix) {
    const ticket = bridge.getIframeTokenFromRequest(request, url.pathname);
    if (ticket && bridge.verifyIframeToken(ticket, sessionPrefix)) {
      const res = await forwardWithKey(request);
      if (cookieSafeSid) {
        const cookie = bridge.issueUiCookieToken(
          cookieSafeSid,
          PLAN_COOKIE_TTL_S,
        );
        const withCookie = new Response(res.body, res);
        withCookie.headers.append(
          "set-cookie",
          `vt_ui_${cookieSafeSid}=${cookie.token}; HttpOnly; Secure; SameSite=None; Path=/plan/${cookieSafeSid}/; Max-Age=${PLAN_COOKIE_TTL_S}`,
        );
        return withCookie;
      }
      return res;
    }
  }

  // 3 + 4) Forward first and let the provider's proxy be the authority.
  // If a TOP-LEVEL document navigation is rejected (401/403), serve the
  // `#vt` bootstrap; assets just return the proxy's 401.
  const forwarded = await forwarder.handle(request);
  const wantsDoc =
    request.method === "GET" &&
    (request.headers.get("sec-fetch-dest") === "iframe" ||
      request.headers.get("sec-fetch-dest") === "document" ||
      request.headers.get("sec-fetch-mode") === "navigate" ||
      (request.headers.get("accept") ?? "").includes("text/html"));
  if (
    sid &&
    wantsDoc &&
    (forwarded.status === 401 || forwarded.status === 403)
  ) {
    return new Response(renderPlanBootstrapHtml(), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "Content-Security-Policy": bridge.frameAncestorsCsp(),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  }
  return forwarded;
}

/**
 * Build a `PlanProxyForwarder` that delegates to the active plan
 * provider's `proxyRequest` method. Falls back to a 503 stub when no
 * provider is registered or the provider doesn't implement
 * `proxyRequest` (headless providers).
 */
export function createProviderForwarder(
  host: HostServices,
): PlanProxyForwarder {
  return {
    handle: async (req: Request): Promise<Response> => {
      const provider = host.getProvider?.<PlanProvider>("plan");
      if (!provider) {
        return new Response(
          JSON.stringify({ error: "No plan provider registered" }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (typeof provider.proxyRequest !== "function") {
        return new Response(
          JSON.stringify({
            error: `Plan provider '${provider.name}' does not expose a UI proxy`,
          }),
          {
            status: 501,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return provider.proxyRequest(req);
    },
  };
}
