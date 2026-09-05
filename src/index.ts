export interface Env {
  DATA: KVNamespace;
  ASSETS: Fetcher;
  OPENAI_API_KEY: string;
  APP_TOKEN: string;
  OPENAI_MODEL?: string;
}

type Role = "user" | "assistant";

type Message = {
  role: Role;
  content: string;
  createdAt: string;
};

type Project = {
  id: string;
  name: string;
  instructions: string;
  files: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

type ProjectMeta = Omit<Project, "files"> & { fileNames: string[] };

type Conversation = {
  id: string;
  title: string;
  projectId: string | null;
  mode: "chat" | "code";
  messages: Message[];
  createdAt: string;
  updatedAt: string;
};

type ConversationMeta = Omit<Conversation, "messages"> & { messageCount: number };

type PluginManifest = {
  id: string;
  name: string;
  description: string;
  url: string;
  createdAt: string;
};

const BASE_INSTRUCTIONS = `You are HanGPT, a capable personal AI assistant running inside a Cloudflare-hosted workspace. Be concise by default, but be thorough when the task needs it. Never claim that you performed an external action unless a provided tool actually completed it.`;
const MAX_FILE_SIZE = 250_000;
const MAX_PROJECT_BYTES = 2_000_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/api/health" && request.method === "GET") {
        return json({ ok: true, app: "HanGPT", version: "0.1.0" });
      }

      if (!path.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }

      if (!env.APP_TOKEN) return json({ error: "APP_TOKEN is not configured" }, 500);
      if (!authorized(request, env.APP_TOKEN)) return json({ error: "Unauthorized" }, 401);

      if (path === "/api/projects") {
        if (request.method === "GET") return json(await loadIndex<ProjectMeta>(env, "projects:index"));
        if (request.method === "POST") {
          const body = await bodyJson(request);
          const now = new Date().toISOString();
          const project: Project = {
            id: crypto.randomUUID(),
            name: cleanText(body.name, "Untitled project", 120),
            instructions: cleanText(body.instructions, "", 12_000),
            files: {},
            createdAt: now,
            updatedAt: now,
          };
          await saveProject(env, project);
          return json(project, 201);
        }
      }

      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch) {
        const id = projectMatch[1];
        const project = await env.DATA.get<Project>(`project:${id}`, "json");
        if (!project) return json({ error: "Project not found" }, 404);
        if (request.method === "GET") return json(project);
        if (request.method === "PUT") {
          const body = await bodyJson(request);
          project.name = cleanText(body.name, project.name, 120);
          project.instructions = cleanText(body.instructions, project.instructions, 12_000);
          project.updatedAt = new Date().toISOString();
          await saveProject(env, project);
          return json(project);
        }
        if (request.method === "DELETE") {
          await env.DATA.delete(`project:${id}`);
          await removeFromIndex(env, "projects:index", id);
          return json({ ok: true });
        }
      }

      const filesMatch = path.match(/^\/api\/projects\/([^/]+)\/files$/);
      if (filesMatch) {
        const id = filesMatch[1];
        const project = await env.DATA.get<Project>(`project:${id}`, "json");
        if (!project) return json({ error: "Project not found" }, 404);
        const queryPath = url.searchParams.get("path");
        if (request.method === "GET") {
          if (!queryPath) return json({ files: Object.keys(project.files).sort() });
          const filePath = normalizePath(queryPath);
          if (!(filePath in project.files)) return json({ error: "File not found" }, 404);
          return json({ path: filePath, content: project.files[filePath] });
        }
        if (request.method === "PUT") {
          const body = await bodyJson(request);
          const filePath = normalizePath(String(body.path || ""));
          const content = String(body.content ?? "");
          assertFileSize(content);
          assertProjectSize({ ...project.files, [filePath]: content });
          project.files[filePath] = content;
          project.updatedAt = new Date().toISOString();
          await saveProject(env, project);
          return json({ ok: true, path: filePath });
        }
        if (request.method === "DELETE") {
          const filePath = normalizePath(queryPath || "");
          delete project.files[filePath];
          project.updatedAt = new Date().toISOString();
          await saveProject(env, project);
          return json({ ok: true });
        }
      }

      if (path === "/api/conversations") {
        if (request.method === "GET") return json(await loadIndex<ConversationMeta>(env, "conversations:index"));
        if (request.method === "POST") {
          const body = await bodyJson(request);
          const conversation = newConversation(body.projectId || null, body.mode === "code" ? "code" : "chat", cleanText(body.title, "New chat", 120));
          await saveConversation(env, conversation);
          return json(conversation, 201);
        }
      }

      const conversationMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
      if (conversationMatch) {
        const id = conversationMatch[1];
        const conversation = await env.DATA.get<Conversation>(`conversation:${id}`, "json");
        if (!conversation) return json({ error: "Conversation not found" }, 404);
        if (request.method === "GET") return json(conversation);
        if (request.method === "PUT") {
          const body = await bodyJson(request);
          conversation.title = cleanText(body.title, conversation.title, 120);
          if ("projectId" in body) conversation.projectId = body.projectId || null;
          conversation.updatedAt = new Date().toISOString();
          await saveConversation(env, conversation);
          return json(conversation);
        }
        if (request.method === "DELETE") {
          await env.DATA.delete(`conversation:${id}`);
          await removeFromIndex(env, "conversations:index", id);
          return json({ ok: true });
        }
      }

      if (path === "/api/chat" && request.method === "POST") {
        return await handleChat(request, env);
      }

      if (path === "/api/plugins") {
        if (request.method === "GET") return json(await loadIndex<PluginManifest>(env, "plugins:index"));
        if (request.method === "POST") {
          const body = await bodyJson(request);
          const pluginUrl = validatePluginUrl(String(body.url || ""));
          const plugin: PluginManifest = {
            id: crypto.randomUUID(),
            name: cleanText(body.name, new URL(pluginUrl).hostname, 100),
            description: cleanText(body.description, "", 500),
            url: pluginUrl,
            createdAt: new Date().toISOString(),
          };
          await upsertIndex(env, "plugins:index", plugin);
          return json(plugin, 201);
        }
      }

      const pluginMatch = path.match(/^\/api\/plugins\/([^/]+)$/);
      if (pluginMatch && request.method === "DELETE") {
        await removeFromIndex(env, "plugins:index", pluginMatch[1]);
        return json({ ok: true });
      }

      const pluginCallMatch = path.match(/^\/api\/plugins\/([^/]+)\/call$/);
      if (pluginCallMatch && request.method === "POST") {
        return await callPlugin(request, env, pluginCallMatch[1]);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      return json({ error: message }, 500);
    }
  },
};

async function handleChat(request: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY is not configured" }, 500);
  const body = await bodyJson(request);
  const userText = cleanText(body.message, "", 50_000).trim();
  if (!userText) return json({ error: "Message is required" }, 400);

  const mode: "chat" | "code" = body.mode === "code" ? "code" : "chat";
  const projectId = body.projectId ? String(body.projectId) : null;
  let project: Project | null = projectId ? await env.DATA.get<Project>(`project:${projectId}`, "json") : null;
  if (projectId && !project) return json({ error: "Project not found" }, 404);
  if (mode === "code" && !project) return json({ error: "Code mode requires a project" }, 400);

  let conversation: Conversation | null = body.conversationId
    ? await env.DATA.get<Conversation>(`conversation:${String(body.conversationId)}`, "json")
    : null;

  if (!conversation) {
    conversation = newConversation(projectId, mode, titleFrom(userText));
  }
  conversation.projectId = projectId;
  conversation.mode = mode;
  conversation.messages.push({ role: "user", content: userText, createdAt: new Date().toISOString() });
  if (conversation.messages.length > 200) conversation.messages = conversation.messages.slice(-200);

  const model = chooseModel(body.model, env.OPENAI_MODEL);
  const reasoning = chooseReasoning(body.reasoning);
  const tools: any[] = [];
  if (body.webSearch === true) tools.push({ type: "web_search" });
  if (mode === "code") tools.push(...codeTools());

  let instructions = BASE_INSTRUCTIONS;
  if (project) {
    instructions += `\n\nProject: ${project.name}\nProject instructions:\n${project.instructions || "No extra project instructions."}`;
  }
  if (mode === "code") {
    instructions += `\n\nYou are in Code mode. Use the project file tools proactively to inspect and modify the virtual filesystem. Prefer editing files over merely describing edits when the user asks for implementation. Never report a file as changed unless write_file or delete_file succeeded. Existing files: ${Object.keys(project!.files).sort().join(", ") || "(none)"}.`;
  }

  const input = conversation.messages.slice(-80).map((message) => ({ role: message.role, content: message.content }));
  const settings = {
    model,
    instructions,
    reasoning: { effort: reasoning },
    text: { verbosity: "medium" },
    tools,
  };

  let response = await openAI(env, { ...settings, input });
  let filesChanged = false;

  if (mode === "code" && project) {
    for (let round = 0; round < 8; round++) {
      const calls = getFunctionCalls(response);
      if (!calls.length) break;
      const outputs: any[] = [];
      for (const call of calls) {
        let args: any = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch { args = {}; }
        const executed = executeCodeTool(project, call.name, args);
        filesChanged ||= executed.changed;
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(executed.output) });
      }
      if (filesChanged) {
        project.updatedAt = new Date().toISOString();
        await saveProject(env, project);
      }
      response = await openAI(env, {
        ...settings,
        previous_response_id: response.id,
        input: outputs,
      });
    }
  }

  const assistantText = extractOutputText(response) || "Done. Review the workspace and continue with another instruction if needed.";
  conversation.messages.push({ role: "assistant", content: assistantText, createdAt: new Date().toISOString() });
  conversation.updatedAt = new Date().toISOString();
  if (conversation.title === "New chat") conversation.title = titleFrom(userText);
  await saveConversation(env, conversation);

  return json({
    text: assistantText,
    conversation,
    project,
    responseId: response.id,
    usage: response.usage || null,
  });
}

function codeTools(): any[] {
  return [
    {
      type: "function",
      name: "list_files",
      description: "List every file path in the current project workspace.",
      strict: true,
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
    {
      type: "function",
      name: "read_file",
      description: "Read a UTF-8 text file from the current project workspace.",
      strict: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative file path" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "write_file",
      description: "Create or completely replace a UTF-8 text file in the current project workspace.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          content: { type: "string", description: "Complete file contents" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "delete_file",
      description: "Delete a file from the current project workspace.",
      strict: true,
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative file path" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ];
}

function executeCodeTool(project: Project, name: string, args: any): { output: any; changed: boolean } {
  try {
    if (name === "list_files") return { output: { files: Object.keys(project.files).sort() }, changed: false };
    if (name === "read_file") {
      const path = normalizePath(String(args.path || ""));
      if (!(path in project.files)) return { output: { error: "File not found", path }, changed: false };
      return { output: { path, content: project.files[path] }, changed: false };
    }
    if (name === "write_file") {
      const path = normalizePath(String(args.path || ""));
      const content = String(args.content ?? "");
      assertFileSize(content);
      assertProjectSize({ ...project.files, [path]: content });
      project.files[path] = content;
      return { output: { ok: true, path, bytes: content.length }, changed: true };
    }
    if (name === "delete_file") {
      const path = normalizePath(String(args.path || ""));
      const existed = path in project.files;
      delete project.files[path];
      return { output: { ok: true, path, existed }, changed: existed };
    }
    return { output: { error: `Unknown tool: ${name}` }, changed: false };
  } catch (error) {
    return { output: { error: error instanceof Error ? error.message : "Tool failed" }, changed: false };
  }
}

async function openAI(env: Env, payload: any): Promise<any> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = { raw }; }
  if (!response.ok) {
    const detail = data?.error?.message || data?.raw || `OpenAI request failed (${response.status})`;
    throw new Error(String(detail).slice(0, 1200));
  }
  return data;
}

function getFunctionCalls(response: any): any[] {
  return Array.isArray(response?.output) ? response.output.filter((item: any) => item?.type === "function_call") : [];
}

function extractOutputText(response: any): string {
  if (typeof response?.output_text === "string" && response.output_text.trim()) return response.output_text.trim();
  const parts: string[] = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function callPlugin(request: Request, env: Env, id: string): Promise<Response> {
  const plugins = await loadIndex<PluginManifest>(env, "plugins:index");
  const plugin = plugins.find((item) => item.id === id);
  if (!plugin) return json({ error: "Plugin not found" }, 404);
  const body = await bodyJson(request);
  const payload = body.payload ?? {};
  const encoded = JSON.stringify(payload);
  if (encoded.length > 200_000) return json({ error: "Plugin payload is too large" }, 413);

  const extraHeaders: Record<string, string> = {};
  if (body.headers && typeof body.headers === "object") {
    for (const [key, value] of Object.entries(body.headers)) {
      const lower = key.toLowerCase();
      if (lower === "host" || lower === "content-length" || lower.startsWith("cf-")) continue;
      extraHeaders[key] = String(value);
    }
  }

  const upstream = await fetch(plugin.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: encoded,
  });
  const text = (await upstream.text()).slice(0, 100_000);
  return json({
    ok: upstream.ok,
    status: upstream.status,
    contentType: upstream.headers.get("content-type"),
    body: text,
  }, upstream.ok ? 200 : 502);
}

function validatePluginUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("Plugin URL is invalid"); }
  if (url.protocol !== "https:") throw new Error("Plugin URL must use HTTPS");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host === "::1" || host.endsWith(".local")) throw new Error("Local/private plugin hosts are not allowed");
  if (isPrivateIPv4(host) || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) throw new Error("Private plugin hosts are not allowed");
  return url.toString();
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function chooseModel(requested: unknown, fallback?: string): string {
  const value = typeof requested === "string" ? requested : fallback || "gpt-5.6";
  const allowed = new Set(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  return allowed.has(value) ? value : "gpt-5.6";
}

function chooseReasoning(value: unknown): string {
  const allowed = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
  return typeof value === "string" && allowed.has(value) ? value : "medium";
}

function newConversation(projectId: string | null, mode: "chat" | "code", title: string): Conversation {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title, projectId, mode, messages: [], createdAt: now, updatedAt: now };
}

async function saveProject(env: Env, project: Project): Promise<void> {
  await env.DATA.put(`project:${project.id}`, JSON.stringify(project));
  await upsertIndex<ProjectMeta>(env, "projects:index", projectMeta(project));
}

function projectMeta(project: Project): ProjectMeta {
  const { files, ...rest } = project;
  return { ...rest, fileNames: Object.keys(files).sort() };
}

async function saveConversation(env: Env, conversation: Conversation): Promise<void> {
  await env.DATA.put(`conversation:${conversation.id}`, JSON.stringify(conversation));
  const { messages, ...rest } = conversation;
  await upsertIndex<ConversationMeta>(env, "conversations:index", { ...rest, messageCount: messages.length });
}

async function loadIndex<T>(env: Env, key: string): Promise<T[]> {
  return (await env.DATA.get<T[]>(key, "json")) || [];
}

async function upsertIndex<T extends { id: string }>(env: Env, key: string, item: T): Promise<void> {
  const current = await loadIndex<T>(env, key);
  const next = [item, ...current.filter((entry) => entry.id !== item.id)].slice(0, 500);
  await env.DATA.put(key, JSON.stringify(next));
}

async function removeFromIndex(env: Env, key: string, id: string): Promise<void> {
  const current = await loadIndex<{ id: string }>(env, key);
  await env.DATA.put(key, JSON.stringify(current.filter((entry) => entry.id !== id)));
}

function authorized(request: Request, secret: string): boolean {
  const provided = request.headers.get("Authorization") || "";
  const expected = `Bearer ${secret}`;
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

async function bodyJson(request: Request): Promise<any> {
  const text = await request.text();
  if (!text) return {};
  if (text.length > 1_000_000) throw new Error("Request body is too large");
  try { return JSON.parse(text); } catch { throw new Error("Request body must be valid JSON"); }
}

function cleanText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  return value.slice(0, max);
}

function titleFrom(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 52 ? `${compact.slice(0, 49)}…` : compact || "New chat";
}

function normalizePath(input: string): string {
  const path = input.trim().replace(/^\.\//, "");
  if (!path || path.length > 240 || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("Invalid relative file path");
  }
  return path;
}

function assertFileSize(content: string): void {
  if (content.length > MAX_FILE_SIZE) throw new Error(`File exceeds ${MAX_FILE_SIZE} characters`);
}

function assertProjectSize(files: Record<string, string>): void {
  const total = Object.values(files).reduce((sum, value) => sum + value.length, 0);
  if (total > MAX_PROJECT_BYTES) throw new Error(`Project files exceed ${MAX_PROJECT_BYTES} characters total`);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
