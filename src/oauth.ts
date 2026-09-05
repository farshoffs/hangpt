import type { Env, PluginManifest } from "./types";
import { json, cleanText, getJson, putJson, deleteKey, putProjectSecret, getProjectSecret, loadIndex } from "./core";

export async function oauthStart(request: Request, env: Env, plugin: PluginManifest): Promise<Response> {
  if (!plugin.oauth || plugin.authType !== "oauth2") return json({ error: "Plugin is not configured for OAuth2" }, 400);
  if (!env.MASTER_KEY) return json({ error: "MASTER_KEY is required for OAuth token storage" }, 501);
  const state = crypto.randomUUID().replace(/-/g, "");
  const redirectUri = new URL(`/api/plugins/${encodeURIComponent(plugin.id)}/oauth/callback`, request.url).toString();
  await putJson(env, `oauth-state:${state}`, { pluginId: plugin.id, redirectUri, createdAt: Date.now() });
  const authUrl = new URL(plugin.oauth.authorizationUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", plugin.oauth.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  if (plugin.oauth.scopes?.length) authUrl.searchParams.set("scope", plugin.oauth.scopes.join(" "));
  return json({ authorizationUrl: authUrl.toString(), state, redirectUri });
}

export async function oauthSetClientSecret(env: Env, pluginId: string, secret: string): Promise<Response> {
  if (!secret.trim()) return json({ error: "clientSecret is required" }, 400);
  await putProjectSecret(env, "_oauth_clients", pluginId, secret);
  return json({ ok: true });
}

export async function oauthCallback(request: Request, env: Env, pluginId: string): Promise<Response> {
  const url = new URL(request.url); const state = url.searchParams.get("state") || ""; const code = url.searchParams.get("code") || ""; const providerError = url.searchParams.get("error");
  if (providerError) return oauthHtml(false, `OAuth provider returned: ${providerError}`);
  if (!state || !code) return oauthHtml(false, "Missing OAuth state or code");
  const stateRecord = await getJson<{ pluginId: string; redirectUri: string; createdAt: number }>(env, `oauth-state:${state}`);
  if (!stateRecord || stateRecord.pluginId !== pluginId || Date.now() - stateRecord.createdAt > 10 * 60 * 1000) return oauthHtml(false, "OAuth state is invalid or expired");
  const plugins = await loadIndex<PluginManifest>(env, "plugins:index"); const plugin = plugins.find((p) => p.id === pluginId);
  if (!plugin?.oauth || plugin.authType !== "oauth2") return oauthHtml(false, "OAuth plugin configuration was not found");
  const clientSecret = await getProjectSecret(env, "_oauth_clients", pluginId); if (!clientSecret) return oauthHtml(false, "OAuth client secret has not been configured");
  const form = new URLSearchParams(); form.set("grant_type", "authorization_code"); form.set("code", code); form.set("redirect_uri", stateRecord.redirectUri); form.set("client_id", plugin.oauth.clientId); form.set("client_secret", clientSecret);
  const tokenResponse = await fetch(plugin.oauth.tokenUrl, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const tokenText = await tokenResponse.text(); let tokenData: any; try { tokenData = JSON.parse(tokenText); } catch { tokenData = Object.fromEntries(new URLSearchParams(tokenText)); }
  if (!tokenResponse.ok || !tokenData?.access_token) return oauthHtml(false, cleanText(tokenData?.error_description || tokenData?.error || tokenText || "Token exchange failed", "Token exchange failed", 1000));
  await putProjectSecret(env, "_plugins", pluginId, String(tokenData.access_token)); if (tokenData.refresh_token) await putProjectSecret(env, "_plugins", `${pluginId}:refresh`, String(tokenData.refresh_token)); await deleteKey(env, `oauth-state:${state}`);
  return oauthHtml(true, `${plugin.name} connected successfully. You can close this window.`);
}

function oauthHtml(ok: boolean, message: string): Response {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  const safe = message.replace(/[&<>"']/g, (c) => map[c] || c);
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HanGPT OAuth</title><style>body{font-family:system-ui;background:#171717;color:#eee;display:grid;place-items:center;height:100vh;margin:0}.card{max-width:520px;padding:28px;background:#242424;border:1px solid #383838;border-radius:16px}h1{font-size:20px}p{color:#aaa;line-height:1.5}.dot{width:12px;height:12px;border-radius:50%;background:${ok ? "#69d091" : "#e27474"}}</style></head><body><div class="card"><div class="dot"></div><h1>${ok ? "Connected" : "Connection failed"}</h1><p>${safe}</p></div></body></html>`, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
