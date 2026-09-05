import type { Env, Conversation, Project, AgentProfile, MemoryItem } from "./types";
import { saveConversation, saveProject, titleFrom } from "./core";

const BASE_INSTRUCTIONS = `You are HanGPT, a capable personal AI assistant running inside a Cloudflare-hosted workspace. Be useful, accurate, and action-oriented. Never claim an external action happened unless a tool call actually completed it.`;

export function chooseModel(requested: unknown, fallback?: string): string {
  const value = typeof requested === "string" ? requested : "";
  const allowed = new Set(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  return allowed.has(value) ? value : (fallback || "gpt-5.6");
}

export function chooseReasoning(value: unknown): string {
  return ["none", "low", "medium", "high", "xhigh", "max"].includes(String(value)) ? String(value) : "medium";
}

export async function runChat(args: {
  env: Env;
  conversation: Conversation;
  project: Project | null;
  userText: string;
  model?: unknown;
  reasoning?: unknown;
  webSearch?: boolean;
  mode: "chat" | "code";
  agent?: AgentProfile | null;
  memories?: MemoryItem[];
}): Promise<{ text: string; responseId?: string; usage?: unknown; project: Project | null }> {
  const { env, conversation, userText, mode } = args;
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  conversation.messages.push({ role: "user", content: userText, createdAt: new Date().toISOString() });
  if (conversation.messages.length > 200) conversation.messages = conversation.messages.slice(-200);

  const project = args.project;
  const model = chooseModel(args.model || project?.settings?.defaultModel || args.agent?.model, env.OPENAI_MODEL);
  const reasoning = chooseReasoning(args.reasoning || project?.settings?.reasoning || args.agent?.reasoning);
  const tools: any[] = [];
  const wantsWeb = args.webSearch === true || project?.settings?.webSearch === true || args.agent?.tools.includes("web_search");
  if (wantsWeb) tools.push({ type: "web_search" });
  if (mode === "code") tools.push(...codeTools(Boolean(project?.settings?.github)));

  let instructions = BASE_INSTRUCTIONS;
  if (args.agent) instructions += `\n\nActive agent: ${args.agent.name}\n${args.agent.instructions}`;
  if (project) instructions += `\n\nProject: ${project.name}\nProject instructions:\n${project.instructions || "No extra project instructions."}`;
  if (args.memories?.length) instructions += `\n\nRelevant saved memory:\n${args.memories.map((m) => `- ${m.text}`).join("\n")}`;
  if (mode === "code" && project) instructions += `\n\nYou are in Code mode. Use file tools proactively. Existing virtual files: ${Object.keys(project.files).sort().join(", ") || "(none)"}. If GitHub tools are available, prefer them when the user asks to work on the linked repository.`;

  const input = conversation.messages.slice(-80).map((m) => ({ role: m.role, content: m.content }));
  const settings: any = { model, instructions, reasoning: { effort: reasoning }, text: { verbosity: "medium" }, tools };
  let response = await openAIResponse(env, { ...settings, input });
  let changed = false;

  if (mode === "code" && project) {
    for (let round = 0; round < 10; round++) {
      const calls = getFunctionCalls(response);
      if (!calls.length) break;
      const outputs: any[] = [];
      for (const call of calls) {
        let parsed: any = {};
        try { parsed = JSON.parse(call.arguments || "{}"); } catch { parsed = {}; }
        let output: any;
        if (call.name.startsWith("github_")) output = await executeGitHubTool(env, project, call.name, parsed);
        else {
          const local = executeCodeTool(project, call.name, parsed);
          output = local.output;
          changed ||= local.changed;
        }
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
      }
      if (changed) {
        project.updatedAt = new Date().toISOString();
        await saveProject(env, project);
        changed = false;
      }
      response = await openAIResponse(env, { ...settings, previous_response_id: response.id, input: outputs });
    }
  }

  const text = extractOutputText(response) || "Done.";
  conversation.messages.push({ role: "assistant", content: text, createdAt: new Date().toISOString() });
  conversation.updatedAt = new Date().toISOString();
  if (conversation.title === "New chat") conversation.title = titleFrom(userText);
  await saveConversation(env, conversation);
  return { text, responseId: response.id, usage: response.usage || null, project };
}

export async function streamChat(args: Parameters<typeof runChat>[0]): Promise<Response> {
  const env = args.env;
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const conversation = args.conversation;
  conversation.messages.push({ role: "user", content: args.userText, createdAt: new Date().toISOString() });
  const project = args.project;
  const model = chooseModel(args.model || project?.settings?.defaultModel || args.agent?.model, env.OPENAI_MODEL);
  const reasoning = chooseReasoning(args.reasoning || project?.settings?.reasoning || args.agent?.reasoning);
  let instructions = BASE_INSTRUCTIONS;
  if (args.agent) instructions += `\n\nActive agent: ${args.agent.name}\n${args.agent.instructions}`;
  if (project) instructions += `\n\nProject: ${project.name}\n${project.instructions}`;
  if (args.memories?.length) instructions += `\n\nRelevant saved memory:\n${args.memories.map((m) => `- ${m.text}`).join("\n")}`;
  const tools: any[] = [];
  if (args.webSearch === true || project?.settings?.webSearch === true) tools.push({ type: "web_search" });
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model, instructions, reasoning: { effort: reasoning }, input: conversation.messages.slice(-80).map((m) => ({ role: m.role, content: m.content })), tools, stream: true }),
  });
  if (!upstream.ok || !upstream.body) return new Response(await upstream.text(), { status: upstream.status });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let collected = "";
  const stream = new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        if (collected) {
          conversation.messages.push({ role: "assistant", content: collected, createdAt: new Date().toISOString() });
          conversation.updatedAt = new Date().toISOString();
          if (conversation.title === "New chat") conversation.title = titleFrom(args.userText);
          await saveConversation(env, conversation);
        }
        controller.close();
        return;
      }
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") collected += event.delta;
        } catch {}
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
      controller.enqueue(encoder.encode(chunk));
    },
    cancel() { reader.cancel(); },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

async function openAIResponse(env: Env, payload: any): Promise<any> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json<any>();
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI request failed (${response.status})`);
  return data;
}

export async function generateImage(env: Env, prompt: string, size = "1024x1024"): Promise<any> {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2", prompt, size }),
  });
  const data = await response.json<any>();
  if (!response.ok) throw new Error(data?.error?.message || "Image generation failed");
  return data;
}

export async function synthesizeSpeech(env: Env, input: string, voice = "alloy"): Promise<Response> {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice, input, format: "mp3" }),
  });
  if (!response.ok) throw new Error(await response.text());
  return new Response(response.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}

export async function transcribeAudio(env: Env, file: File): Promise<any> {
  const form = new FormData();
  form.set("model", "gpt-transcribe");
  form.set("file", file, file.name || "audio.webm");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: form });
  const data = await response.json<any>();
  if (!response.ok) throw new Error(data?.error?.message || "Transcription failed");
  return data;
}

function extractOutputText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  const chunks: string[] = [];
  for (const item of response?.output || []) for (const content of item?.content || []) if (content?.type === "output_text" && content.text) chunks.push(content.text);
  return chunks.join("\n");
}

function getFunctionCalls(response: any): any[] {
  return (response?.output || []).filter((item: any) => item?.type === "function_call");
}

function codeTools(withGitHub: boolean): any[] {
  const tools: any[] = [
    { type: "function", name: "list_files", description: "List virtual project files", strict: true, parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
    { type: "function", name: "read_file", description: "Read a virtual project file", strict: true, parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
    { type: "function", name: "write_file", description: "Create or replace a virtual project file", strict: true, parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } },
    { type: "function", name: "delete_file", description: "Delete a virtual project file", strict: true, parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  ];
  if (withGitHub) tools.push(
    { type: "function", name: "github_read_file", description: "Read a file from the linked GitHub repository", strict: true, parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
    { type: "function", name: "github_write_file", description: "Create or replace a file in the linked GitHub repository", strict: true, parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, message: { type: "string" } }, required: ["path", "content", "message"], additionalProperties: false } },
  );
  return tools;
}

function executeCodeTool(project: Project, name: string, args: any): { output: any; changed: boolean } {
  const path = typeof args.path === "string" ? args.path.replace(/^\/+/, "") : "";
  if (name === "list_files") return { output: { files: Object.keys(project.files).sort() }, changed: false };
  if (!path || path.includes("..")) return { output: { error: "Invalid path" }, changed: false };
  if (name === "read_file") return { output: path in project.files ? { path, content: project.files[path] } : { error: "File not found", path }, changed: false };
  if (name === "write_file") { project.files[path] = String(args.content ?? "").slice(0, 500_000); return { output: { ok: true, path }, changed: true }; }
  if (name === "delete_file") { const existed = path in project.files; delete project.files[path]; return { output: { ok: true, path, existed }, changed: existed }; }
  return { output: { error: `Unknown tool ${name}` }, changed: false };
}

async function executeGitHubTool(env: Env, project: Project, name: string, args: any): Promise<any> {
  if (!env.GITHUB_TOKEN) return { error: "GITHUB_TOKEN is not configured" };
  const config = project.settings?.github;
  if (!config) return { error: "Project has no linked GitHub repository" };
  const path = String(args.path || "").replace(/^\/+/, "");
  if (!path || path.includes("..")) return { error: "Invalid path" };
  const base = `https://api.github.com/repos/${config.repo}/contents/${encodePath(path)}`;
  if (name === "github_read_file") {
    const res = await githubFetch(env, `${base}?ref=${encodeURIComponent(config.branch || "main")}`);
    if (!res.ok) return { error: await res.text(), status: res.status };
    const data = await res.json<any>();
    return { path, sha: data.sha, content: data.encoding === "base64" ? decodeB64(data.content || "") : data.content };
  }
  if (name === "github_write_file") {
    let sha: string | undefined;
    const current = await githubFetch(env, `${base}?ref=${encodeURIComponent(config.branch || "main")}`);
    if (current.ok) sha = (await current.json<any>()).sha;
    const res = await githubFetch(env, base, { method: "PUT", body: JSON.stringify({ message: String(args.message || `HanGPT update ${path}`), content: encodeB64(String(args.content ?? "")), branch: config.branch || "main", ...(sha ? { sha } : {}) }) });
    const data = await res.json<any>();
    if (!res.ok) return { error: data?.message || "GitHub write failed", status: res.status };
    return { ok: true, path, commit: data?.commit?.sha, url: data?.content?.html_url };
  }
  return { error: "Unknown GitHub tool" };
}

async function githubFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  headers.set("authorization", `Bearer ${env.GITHUB_TOKEN}`);
  headers.set("accept", "application/vnd.github+json");
  headers.set("x-github-api-version", "2022-11-28");
  if (init.body) headers.set("content-type", "application/json");
  return fetch(url, { ...init, headers });
}

function encodePath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
function decodeB64(value: string): string { const raw = atob(value.replace(/\s/g, "")); return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))); }
function encodeB64(value: string): string { const bytes = new TextEncoder().encode(value); let raw = ""; for (const b of bytes) raw += String.fromCharCode(b); return btoa(raw); }
