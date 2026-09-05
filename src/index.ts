import app from "./router";
import type { Env, PluginManifest } from "./types";
import { isAuthorized, json, bodyJson, cleanText, loadIndex, upsertIndex, getProjectSecret } from "./core";
import { oauthStart, oauthSetClientSecret, oauthCallback } from "./oauth";
import { handleBackgroundApi, HanGPTWorkflow } from "./background";

export { HanGPTWorkflow };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const callback = path.match(/^\/api\/plugins\/([^/]+)\/oauth\/callback$/);
    if (callback && request.method === "GET") return oauthCallback(request, env, callback[1]);

    if (path === "/api/jobs" || /^\/api\/jobs\//.test(path)) {
      if (!env.APP_TOKEN || !isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      return handleBackgroundApi(request, env);
    }

    const oauthRoute = path.match(/^\/api\/plugins\/([^/]+)\/oauth\/(config|secret|start)$/);
    const oauthCall = path.match(/^\/api\/plugins\/([^/]+)\/call$/);
    if (oauthRoute || oauthCall) {
      if (!env.APP_TOKEN || !isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      const plugins = await loadIndex<PluginManifest>(env, "plugins:index");
      const pluginId = (oauthRoute || oauthCall)![1];
      const plugin = plugins.find((p) => p.id === pluginId);
      if (!plugin) return json({ error: "Plugin not found" }, 404);

      if (oauthRoute) {
        const action = oauthRoute[2];
        if (action === "config" && request.method === "PUT") {
          const body = await bodyJson(request);
          const authorizationUrl = validateHttps(body.authorizationUrl, "authorizationUrl");
          const tokenUrl = validateHttps(body.tokenUrl, "tokenUrl");
          const clientId = cleanText(body.clientId, "", 500).trim();
          if (!clientId) return json({ error: "clientId is required" }, 400);
          const updated: PluginManifest = { ...plugin, authType: "oauth2", oauth: { authorizationUrl, tokenUrl, clientId, scopes: Array.isArray(body.scopes) ? body.scopes.map(String).slice(0, 30) : [] } };
          await upsertIndex(env, "plugins:index", updated);
          return json(updated);
        }
        if (action === "secret" && request.method === "POST") { const body = await bodyJson(request); return oauthSetClientSecret(env, pluginId, cleanText(body.clientSecret, "", 20_000)); }
        if (action === "start" && request.method === "GET") return oauthStart(request, env, plugin);
        return json({ error: "Method not allowed" }, 405);
      }

      if (oauthCall && plugin.authType === "oauth2" && request.method === "POST") {
        const token = await getProjectSecret(env, "_plugins", plugin.id);
        if (!token) return json({ error: "OAuth plugin is not connected" }, 401);
        const body = await bodyJson(request);
        const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${token}` });
        const extra = body.headers && typeof body.headers === "object" ? body.headers : {};
        for (const [k, v] of Object.entries(extra)) if (!/^(host|content-length|connection|authorization)$/i.test(k)) headers.set(k, String(v));
        const upstream = await fetch(plugin.url, { method: "POST", headers, body: JSON.stringify(body.payload ?? {}) });
        const text = await upstream.text();
        return json({ ok: upstream.ok, status: upstream.status, body: text.slice(0, 250_000) }, upstream.ok ? 200 : 502);
      }
    }

    return app.fetch(request, env);
  },
};

function validateHttps(value: unknown, field: string): string {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") throw new Error(`${field} must use HTTPS`);
  return url.toString();
}
