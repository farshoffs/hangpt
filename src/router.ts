import type { Env, Project, ProjectMeta, Conversation, ConversationMeta, PluginManifest, MemoryItem, AgentProfile, UploadMeta } from "./types";
import { json, bodyJson, cleanText, normalizePath, assertFileSize, assertProjectSize, MAX_UPLOAD_BYTES, isAuthorized, loadIndex, upsertIndex, removeFromIndex, saveProject, saveConversation, newConversation, putProjectSecret, listProjectSecrets, getProjectSecret, deleteProjectSecret, getJson, deleteKey, putBlob, getBlob, deleteBlob } from "./core";
import { runChat, streamChat, generateImage, synthesizeSpeech, transcribeAudio } from "./openai";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url); const path = url.pathname;
    try {
      if (path === "/api/health" && request.method === "GET") return json({ ok: true, app: "HanGPT", version: "1.0.0", features: ["streaming", "uploads", "memory", "agents", "images", "voice", "github", "encrypted-secrets", "plugins", "access-ready-auth", "d1-adapter", "r2-adapter"] });
      if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
      if (!env.APP_TOKEN) return json({ error: "APP_TOKEN is not configured" }, 500);
      if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      return (await routeApi(request, env, url)) || json({ error: "Not found" }, 404);
    } catch (error) { return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500); }
  },
};

async function routeApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/api/capabilities" && request.method === "GET") return json({ openai: Boolean(env.OPENAI_API_KEY), github: Boolean(env.GITHUB_TOKEN), encryptedSecrets: Boolean(env.MASTER_KEY), d1: Boolean(env.DB), r2: Boolean(env.FILES), cloudflareAccessRequired: String(env.CF_ACCESS_REQUIRED || "").toLowerCase() === "true", models: ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], media: { image: "gpt-image-2", speech: "gpt-4o-mini-tts", transcription: "gpt-transcribe" } });

  if (path === "/api/projects") {
    if (request.method === "GET") return json(await loadIndex<ProjectMeta>(env, "projects:index"));
    if (request.method === "POST") { const body = await bodyJson(request); const now = new Date().toISOString(); const project: Project = { id: crypto.randomUUID(), name: cleanText(body.name, "Untitled project", 120), instructions: cleanText(body.instructions, "", 20_000), files: {}, settings: { memoryEnabled: true }, createdAt: now, updatedAt: now }; await saveProject(env, project); return json(project, 201); }
  }

  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const project = await getProject(env, projectMatch[1]); if (!project) return json({ error: "Project not found" }, 404);
    if (request.method === "GET") return json(project);
    if (request.method === "PUT") { const body = await bodyJson(request); project.name = cleanText(body.name, project.name, 120); project.instructions = cleanText(body.instructions, project.instructions, 20_000); project.updatedAt = new Date().toISOString(); await saveProject(env, project); return json(project); }
    if (request.method === "DELETE") { await deleteKey(env, `project:${project.id}`); await deleteKey(env, `project:${project.id}:secrets`); await removeFromIndex(env, "projects:index", project.id); return json({ ok: true }); }
  }

  const settingsMatch = path.match(/^\/api\/projects\/([^/]+)\/settings$/);
  if (settingsMatch) {
    const project = await getProject(env, settingsMatch[1]); if (!project) return json({ error: "Project not found" }, 404);
    if (request.method === "GET") return json(project.settings || {});
    if (request.method === "PUT") { const body = await bodyJson(request); const github = body.github && typeof body.github.repo === "string" ? { repo: cleanText(body.github.repo, "", 200), branch: cleanText(body.github.branch, "main", 100) } : (body.github === null ? null : project.settings?.github); project.settings = { ...project.settings, ...(typeof body.defaultModel === "string" ? { defaultModel: body.defaultModel } : {}), ...(typeof body.reasoning === "string" ? { reasoning: body.reasoning } : {}), ...(typeof body.webSearch === "boolean" ? { webSearch: body.webSearch } : {}), ...(typeof body.memoryEnabled === "boolean" ? { memoryEnabled: body.memoryEnabled } : {}), ...(typeof body.agentId === "string" || body.agentId === null ? { agentId: body.agentId } : {}), ...(body.github !== undefined ? { github } : {}) }; project.updatedAt = new Date().toISOString(); await saveProject(env, project); return json(project.settings); }
  }

  const filesMatch = path.match(/^\/api\/projects\/([^/]+)\/files$/);
  if (filesMatch) {
    const project = await getProject(env, filesMatch[1]); if (!project) return json({ error: "Project not found" }, 404); const queryPath = url.searchParams.get("path");
    if (request.method === "GET") { if (!queryPath) return json({ files: Object.keys(project.files).sort() }); const p = normalizePath(queryPath); return p in project.files ? json({ path: p, content: project.files[p] }) : json({ error: "File not found" }, 404); }
    if (request.method === "PUT") { const body = await bodyJson(request); const p = normalizePath(String(body.path || "")); const content = String(body.content ?? ""); assertFileSize(content); assertProjectSize({ ...project.files, [p]: content }); project.files[p] = content; project.updatedAt = new Date().toISOString(); await saveProject(env, project); return json({ ok: true, path: p }); }
    if (request.method === "DELETE") { const p = normalizePath(queryPath || ""); delete project.files[p]; project.updatedAt = new Date().toISOString(); await saveProject(env, project); return json({ ok: true }); }
  }

  const secretsMatch = path.match(/^\/api\/projects\/([^/]+)\/secrets(?:\/([^/]+))?$/);
  if (secretsMatch) {
    const project = await getProject(env, secretsMatch[1]); if (!project) return json({ error: "Project not found" }, 404); const name = secretsMatch[2] ? decodeURIComponent(secretsMatch[2]) : null;
    if (request.method === "GET") return json(await listProjectSecrets(env, project.id));
    if (request.method === "POST" && !name) { const body = await bodyJson(request); const secretName = cleanText(body.name, "", 100).trim(); const value = cleanText(body.value, "", 20_000); if (!secretName || !value) return json({ error: "name and value are required" }, 400); await putProjectSecret(env, project.id, secretName, value); return json({ ok: true, name: secretName }, 201); }
    if (request.method === "DELETE" && name) { await deleteProjectSecret(env, project.id, name); return json({ ok: true }); }
  }

  if (path === "/api/conversations") {
    if (request.method === "GET") return json(await loadIndex<ConversationMeta>(env, "conversations:index"));
    if (request.method === "POST") { const body = await bodyJson(request); const c = newConversation(body.projectId || null, body.mode === "code" ? "code" : "chat", cleanText(body.title, "New chat", 120)); await saveConversation(env, c); return json(c, 201); }
  }
  const convMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
  if (convMatch) {
    const c = await getJson<Conversation>(env, `conversation:${convMatch[1]}`); if (!c) return json({ error: "Conversation not found" }, 404);
    if (request.method === "GET") return json(c);
    if (request.method === "PUT") { const body = await bodyJson(request); c.title = cleanText(body.title, c.title, 120); if ("projectId" in body) c.projectId = body.projectId || null; c.updatedAt = new Date().toISOString(); await saveConversation(env, c); return json(c); }
    if (request.method === "DELETE") { await deleteKey(env, `conversation:${c.id}`); await removeFromIndex(env, "conversations:index", c.id); return json({ ok: true }); }
  }

  if ((path === "/api/chat" || path === "/api/chat/stream") && request.method === "POST") return handleChat(request, env, path.endsWith("/stream"));

  if (path === "/api/memories") {
    if (request.method === "GET") { const projectId = url.searchParams.get("projectId"); const items = await loadIndex<MemoryItem>(env, "memories:index"); return json(projectId ? items.filter((m) => m.scope === "global" || m.projectId === projectId) : items); }
    if (request.method === "POST") { const body = await bodyJson(request); const now = new Date().toISOString(); const item: MemoryItem = { id: crypto.randomUUID(), text: cleanText(body.text, "", 10_000), scope: body.scope === "project" ? "project" : "global", projectId: body.scope === "project" ? String(body.projectId || "") : null, tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 20) : [], createdAt: now, updatedAt: now }; if (!item.text.trim()) return json({ error: "Memory text is required" }, 400); await upsertIndex(env, "memories:index", item); return json(item, 201); }
  }
  const memoryMatch = path.match(/^\/api\/memories\/([^/]+)$/); if (memoryMatch && request.method === "DELETE") { await removeFromIndex(env, "memories:index", memoryMatch[1]); return json({ ok: true }); }

  if (path === "/api/agents") {
    if (request.method === "GET") return json(await loadIndex<AgentProfile>(env, "agents:index"));
    if (request.method === "POST") { const body = await bodyJson(request); const now = new Date().toISOString(); const agent: AgentProfile = { id: crypto.randomUUID(), name: cleanText(body.name, "Agent", 100), description: cleanText(body.description, "", 500), instructions: cleanText(body.instructions, "", 20_000), model: cleanText(body.model, "gpt-5.6", 50), reasoning: cleanText(body.reasoning, "medium", 20), tools: Array.isArray(body.tools) ? body.tools.map(String).slice(0, 20) : [], createdAt: now, updatedAt: now }; await upsertIndex(env, "agents:index", agent); return json(agent, 201); }
  }
  const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch) {
    const agents = await loadIndex<AgentProfile>(env, "agents:index"); const agent = agents.find((a) => a.id === agentMatch[1]); if (!agent) return json({ error: "Agent not found" }, 404);
    if (request.method === "PUT") { const body = await bodyJson(request); const updated: AgentProfile = { ...agent, name: cleanText(body.name, agent.name, 100), description: cleanText(body.description, agent.description, 500), instructions: cleanText(body.instructions, agent.instructions, 20_000), model: cleanText(body.model, agent.model, 50), reasoning: cleanText(body.reasoning, agent.reasoning, 20), tools: Array.isArray(body.tools) ? body.tools.map(String).slice(0, 20) : agent.tools, updatedAt: new Date().toISOString() }; await upsertIndex(env, "agents:index", updated); return json(updated); }
    if (request.method === "DELETE") { await removeFromIndex(env, "agents:index", agent.id); return json({ ok: true }); }
  }

  if (path === "/api/uploads" && request.method === "POST") return handleUpload(request, env);
  if (path === "/api/uploads" && request.method === "GET") return json(await loadIndex<UploadMeta>(env, "uploads:index"));
  const uploadMatch = path.match(/^\/api\/uploads\/([^/]+)$/);
  if (uploadMatch) {
    const meta = (await loadIndex<UploadMeta>(env, "uploads:index")).find((u) => u.id === uploadMatch[1]); if (!meta) return json({ error: "Upload not found" }, 404);
    if (request.method === "GET") { const object = await getBlob(env, `upload:${meta.id}:data`); if (!object) return json({ error: "Upload data missing" }, 404); return new Response(object.body, { headers: { "content-type": object.contentType || meta.type || "application/octet-stream", "content-disposition": `inline; filename="${safeFilename(meta.name)}"` } }); }
    if (request.method === "DELETE") { await deleteBlob(env, `upload:${meta.id}:data`); await removeFromIndex(env, "uploads:index", meta.id); return json({ ok: true }); }
  }
  const openaiUploadMatch = path.match(/^\/api\/uploads\/([^/]+)\/openai$/); if (openaiUploadMatch && request.method === "POST") return uploadToOpenAI(env, openaiUploadMatch[1]);

  if (path === "/api/media/image" && request.method === "POST") { const body = await bodyJson(request); return json(await generateImage(env, cleanText(body.prompt, "", 20_000), cleanText(body.size, "1024x1024", 40))); }
  if (path === "/api/media/speech" && request.method === "POST") { const body = await bodyJson(request); return synthesizeSpeech(env, cleanText(body.input, "", 30_000), cleanText(body.voice, "alloy", 40)); }
  if (path === "/api/media/transcribe" && request.method === "POST") { const form = await request.formData(); const file = form.get("file"); if (!(file instanceof File)) return json({ error: "file is required" }, 400); return json(await transcribeAudio(env, file)); }

  if (path === "/api/plugins") {
    if (request.method === "GET") return json(await loadIndex<PluginManifest>(env, "plugins:index"));
    if (request.method === "POST") { const body = await bodyJson(request); const pluginUrl = validatePluginUrl(String(body.url || "")); const plugin: PluginManifest = { id: crypto.randomUUID(), name: cleanText(body.name, new URL(pluginUrl).hostname, 100), description: cleanText(body.description, "", 500), url: pluginUrl, authType: ["bearer", "header"].includes(String(body.authType)) ? body.authType : "none", authHeader: cleanText(body.authHeader, "Authorization", 100), secretRef: body.secretRef ? cleanText(body.secretRef, "", 100) : undefined, createdAt: new Date().toISOString() }; await upsertIndex(env, "plugins:index", plugin); return json(plugin, 201); }
  }
  const pluginDelete = path.match(/^\/api\/plugins\/([^/]+)$/); if (pluginDelete && request.method === "DELETE") { await removeFromIndex(env, "plugins:index", pluginDelete[1]); return json({ ok: true }); }
  const pluginToken = path.match(/^\/api\/plugins\/([^/]+)\/token$/); if (pluginToken && request.method === "POST") { const body = await bodyJson(request); await putProjectSecret(env, "_plugins", pluginToken[1], cleanText(body.token, "", 20_000)); return json({ ok: true }); }
  const pluginCall = path.match(/^\/api\/plugins\/([^/]+)\/call$/); if (pluginCall && request.method === "POST") return callPlugin(request, env, pluginCall[1]);

  const ghTree = path.match(/^\/api\/projects\/([^/]+)\/github\/tree$/); if (ghTree && request.method === "GET") return githubTree(env, ghTree[1]);
  const ghFile = path.match(/^\/api\/projects\/([^/]+)\/github\/file$/); if (ghFile) return githubFile(request, env, ghFile[1], url.searchParams.get("path") || "");
  const exec = path.match(/^\/api\/projects\/([^/]+)\/execute$/); if (exec && request.method === "POST") return dispatchExecution(request, env, exec[1]);
  return null;
}

async function handleChat(request: Request, env: Env, streaming: boolean): Promise<Response> {
  const body = await bodyJson(request); const userText = cleanText(body.message, "", 50_000).trim(); if (!userText) return json({ error: "Message is required" }, 400);
  const mode: "chat" | "code" = body.mode === "code" ? "code" : "chat"; const projectId = body.projectId ? String(body.projectId) : null; const project = projectId ? await getProject(env, projectId) : null; if (projectId && !project) return json({ error: "Project not found" }, 404); if (mode === "code" && !project) return json({ error: "Code mode requires a project" }, 400);
  let conversation = body.conversationId ? await getJson<Conversation>(env, `conversation:${String(body.conversationId)}`) : null; if (!conversation) conversation = newConversation(projectId, mode); conversation.projectId = projectId; conversation.mode = mode;
  const agents = await loadIndex<AgentProfile>(env, "agents:index"); const agentId = body.agentId || project?.settings?.agentId; const agent = agentId ? agents.find((a) => a.id === agentId) || null : null;
  const memories = project?.settings?.memoryEnabled === false ? [] : (await loadIndex<MemoryItem>(env, "memories:index")).filter((m) => m.scope === "global" || m.projectId === projectId).slice(0, 30);
  const args = { env, conversation, project, userText, model: body.model, reasoning: body.reasoning, webSearch: body.webSearch === true, mode, agent, memories };
  if (streaming && mode === "chat") return streamChat(args);
  const result = await runChat(args); return json({ ...result, conversation });
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const form = await request.formData(); const file = form.get("file"); if (!(file instanceof File)) return json({ error: "file is required" }, 400); if (file.size > MAX_UPLOAD_BYTES) return json({ error: "Upload exceeds 5 MB limit" }, 413);
  const id = crypto.randomUUID(); const meta: UploadMeta = { id, name: file.name || "upload", type: file.type || "application/octet-stream", bytes: file.size, projectId: form.get("projectId") ? String(form.get("projectId")) : null, createdAt: new Date().toISOString() };
  await putBlob(env, `upload:${id}:data`, await file.arrayBuffer(), meta.type); await upsertIndex(env, "uploads:index", meta); return json(meta, 201);
}

async function uploadToOpenAI(env: Env, id: string): Promise<Response> {
  const items = await loadIndex<UploadMeta>(env, "uploads:index"); const meta = items.find((u) => u.id === id); if (!meta) return json({ error: "Upload not found" }, 404); const object = await getBlob(env, `upload:${id}:data`); if (!object) return json({ error: "Upload data missing" }, 404); const bytes = await new Response(object.body).arrayBuffer();
  const form = new FormData(); form.set("purpose", "assistants"); form.set("file", new File([bytes], meta.name, { type: meta.type })); const res = await fetch("https://api.openai.com/v1/files", { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: form }); const out = await res.json<any>(); if (!res.ok) return json(out, res.status); const updated = { ...meta, openaiFileId: out.id }; await upsertIndex(env, "uploads:index", updated); return json(updated);
}

async function callPlugin(request: Request, env: Env, id: string): Promise<Response> {
  const plugins = await loadIndex<PluginManifest>(env, "plugins:index"); const plugin = plugins.find((p) => p.id === id); if (!plugin) return json({ error: "Plugin not found" }, 404); const body = await bodyJson(request); const headers = new Headers(); headers.set("content-type", "application/json"); const extra = body.headers && typeof body.headers === "object" ? body.headers : {}; for (const [k, v] of Object.entries(extra)) if (!/^(host|content-length|connection)$/i.test(k)) headers.set(k, String(v));
  if (plugin.authType && plugin.authType !== "none") { const token = await getProjectSecret(env, "_plugins", plugin.id); if (token) headers.set(plugin.authType === "bearer" ? "authorization" : (plugin.authHeader || "x-api-key"), plugin.authType === "bearer" ? `Bearer ${token}` : token); }
  const upstream = await fetch(plugin.url, { method: "POST", headers, body: JSON.stringify(body.payload ?? {}) }); const text = await upstream.text(); return json({ ok: upstream.ok, status: upstream.status, body: text.slice(0, 250_000) }, upstream.ok ? 200 : 502);
}

async function githubTree(env: Env, projectId: string): Promise<Response> { const project = await getProject(env, projectId); if (!project?.settings?.github) return json({ error: "GitHub repository not linked" }, 400); if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN is not configured" }, 501); const { repo, branch } = project.settings.github; const res = await gh(env, `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch || "main")}?recursive=1`); const data = await res.json<any>(); return res.ok ? json(data) : json({ error: data.message || "GitHub request failed" }, res.status); }

async function githubFile(request: Request, env: Env, projectId: string, rawPath: string): Promise<Response> {
  const project = await getProject(env, projectId); if (!project?.settings?.github) return json({ error: "GitHub repository not linked" }, 400); if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN is not configured" }, 501); const p = normalizePath(rawPath); const { repo, branch } = project.settings.github; const endpoint = `https://api.github.com/repos/${repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}`;
  if (request.method === "GET") { const res = await gh(env, `${endpoint}?ref=${encodeURIComponent(branch || "main")}`); const data = await res.json<any>(); if (!res.ok) return json({ error: data.message }, res.status); return json({ path: p, sha: data.sha, content: decodeB64(data.content || ""), htmlUrl: data.html_url }); }
  if (request.method === "PUT") { const body = await bodyJson(request); let sha: string | undefined; const current = await gh(env, `${endpoint}?ref=${encodeURIComponent(branch || "main")}`); if (current.ok) sha = (await current.json<any>()).sha; const res = await gh(env, endpoint, { method: "PUT", body: JSON.stringify({ message: cleanText(body.message, `HanGPT update ${p}`, 200), content: encodeB64(String(body.content ?? "")), branch: branch || "main", ...(sha ? { sha } : {}) }) }); const data = await res.json<any>(); return res.ok ? json(data) : json({ error: data.message }, res.status); }
  return json({ error: "Method not allowed" }, 405);
}

async function dispatchExecution(request: Request, env: Env, projectId: string): Promise<Response> { const project = await getProject(env, projectId); if (!project?.settings?.github) return json({ error: "Link a GitHub repository first" }, 400); if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN is not configured" }, 501); const body = await bodyJson(request); const task = String(body.task || ""); if (!["typecheck", "test", "build", "lint"].includes(task)) return json({ error: "Allowed tasks: typecheck, test, build, lint" }, 400); const { repo, branch } = project.settings.github; const workflow = cleanText(body.workflow, "hangpt-exec.yml", 100); const res = await gh(env, `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { method: "POST", body: JSON.stringify({ ref: branch || "main", inputs: { task } }) }); return res.ok ? json({ ok: true, task, repository: repo, workflow }, 202) : json({ error: await res.text(), status: res.status }, res.status); }

async function gh(env: Env, url: string, init: RequestInit = {}): Promise<Response> { const headers = new Headers(init.headers || {}); headers.set("authorization", `Bearer ${env.GITHUB_TOKEN}`); headers.set("accept", "application/vnd.github+json"); headers.set("x-github-api-version", "2022-11-28"); if (init.body) headers.set("content-type", "application/json"); return fetch(url, { ...init, headers }); }
async function getProject(env: Env, id: string): Promise<Project | null> { return getJson<Project>(env, `project:${id}`); }
function validatePluginUrl(raw: string): string { const u = new URL(raw); if (u.protocol !== "https:") throw new Error("Plugin endpoint must use HTTPS"); if (["localhost", "127.0.0.1", "::1"].includes(u.hostname) || u.hostname.endsWith(".local")) throw new Error("Private/local plugin endpoints are not allowed"); return u.toString(); }
function safeFilename(name: string): string { return name.replace(/[\r\n"\\]/g, "_").slice(0, 180); }
function decodeB64(value: string): string { const raw = atob(value.replace(/\s/g, "")); return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))); }
function encodeB64(value: string): string { const bytes = new TextEncoder().encode(value); let raw = ""; for (const b of bytes) raw += String.fromCharCode(b); return btoa(raw); }
