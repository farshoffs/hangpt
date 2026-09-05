import type { Env, Project, ProjectMeta, Conversation, ConversationMeta, SecretRecord } from "./types";

export const MAX_FILE_SIZE = 500_000;
export const MAX_PROJECT_BYTES = 5_000_000;
export const MAX_UPLOAD_BYTES = 5_000_000;

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

export async function bodyJson(request: Request): Promise<Record<string, any>> {
  try { return await request.json() as Record<string, any>; } catch { throw new Error("Invalid JSON body"); }
}

export function cleanText(value: unknown, fallback = "", max = 10_000): string {
  const text = typeof value === "string" ? value : fallback;
  return text.replace(/\u0000/g, "").slice(0, max);
}

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return (line.length > 64 ? line.slice(0, 61) + "…" : line) || "New chat";
}

export function normalizePath(raw: string): string {
  const path = raw.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!path || path.includes("..") || path.startsWith(".")) throw new Error("Invalid file path");
  if (path.length > 240) throw new Error("File path too long");
  return path;
}

export function assertFileSize(content: string): void {
  if (new TextEncoder().encode(content).byteLength > MAX_FILE_SIZE) throw new Error("File exceeds 500 KB limit");
}

export function assertProjectSize(files: Record<string, string>): void {
  const bytes = Object.entries(files).reduce((sum, [path, content]) => sum + path.length + new TextEncoder().encode(content).byteLength, 0);
  if (bytes > MAX_PROJECT_BYTES) throw new Error("Project virtual filesystem exceeds 5 MB limit");
}

export function isAuthorized(request: Request, env: Env): boolean {
  const requireAccess = String(env.CF_ACCESS_REQUIRED || "").toLowerCase() === "true";
  if (requireAccess) {
    const headerName = env.CF_ACCESS_EMAIL_HEADER || "cf-access-authenticated-user-email";
    if (!request.headers.get(headerName)) return false;
  }
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : request.headers.get("x-app-token") || "";
  return Boolean(env.APP_TOKEN && token && constantTimeEqual(token, env.APP_TOKEN));
}

function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a); const bb = new TextEncoder().encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0; for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i]; return diff === 0;
}

async function d1Get<T>(env: Env, key: string): Promise<T | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare("SELECT value FROM app_kv WHERE key = ?1").bind(key).first<{ value: string }>();
    return row?.value ? JSON.parse(row.value) as T : null;
  } catch { return null; }
}

async function d1Put(env: Env, key: string, value: unknown): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare("INSERT INTO app_kv(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(key, JSON.stringify(value), new Date().toISOString()).run();
  } catch {}
}

async function d1Delete(env: Env, key: string): Promise<void> {
  if (!env.DB) return;
  try { await env.DB.prepare("DELETE FROM app_kv WHERE key = ?1").bind(key).run(); } catch {}
}

export async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const fromDb = await d1Get<T>(env, key); if (fromDb !== null) return fromDb;
  return env.DATA.get<T>(key, "json");
}

export async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  await Promise.all([env.DATA.put(key, JSON.stringify(value)), d1Put(env, key, value)]);
}

export async function deleteKey(env: Env, key: string): Promise<void> {
  await Promise.all([env.DATA.delete(key), d1Delete(env, key)]);
}

export async function putBlob(env: Env, key: string, data: ArrayBuffer | ReadableStream, contentType = "application/octet-stream"): Promise<void> {
  if (env.FILES) { await env.FILES.put(key, data, { httpMetadata: { contentType } }); return; }
  await env.DATA.put(key, data as ArrayBuffer);
}

export async function getBlob(env: Env, key: string): Promise<{ body: ReadableStream | ArrayBuffer; contentType?: string } | null> {
  if (env.FILES) {
    const object = await env.FILES.get(key); if (!object) return null;
    return { body: object.body, contentType: object.httpMetadata?.contentType };
  }
  const data = await env.DATA.get(key, "arrayBuffer"); return data ? { body: data } : null;
}

export async function deleteBlob(env: Env, key: string): Promise<void> {
  if (env.FILES) await env.FILES.delete(key); else await env.DATA.delete(key);
}

export async function loadIndex<T>(env: Env, key: string): Promise<T[]> { return (await getJson<T[]>(env, key)) || []; }
export async function saveIndex<T>(env: Env, key: string, items: T[]): Promise<void> { await putJson(env, key, items); }
export async function upsertIndex<T extends { id: string }>(env: Env, key: string, item: T): Promise<void> { const items = await loadIndex<T>(env, key); await saveIndex(env, key, [item, ...items.filter((x) => x.id !== item.id)].slice(0, 1000)); }
export async function removeFromIndex(env: Env, key: string, id: string): Promise<void> { const items = await loadIndex<{ id: string }>(env, key); await saveIndex(env, key, items.filter((x) => x.id !== id)); }

export async function saveProject(env: Env, project: Project): Promise<void> {
  await putJson(env, `project:${project.id}`, project);
  const meta: ProjectMeta = { ...project, files: undefined as never, fileNames: Object.keys(project.files).sort() };
  delete (meta as any).files; await upsertIndex(env, "projects:index", meta);
}

export async function saveConversation(env: Env, conversation: Conversation): Promise<void> {
  await putJson(env, `conversation:${conversation.id}`, conversation);
  const meta: ConversationMeta = { ...conversation, messages: undefined as never, messageCount: conversation.messages.length };
  delete (meta as any).messages; await upsertIndex(env, "conversations:index", meta);
}

export function newConversation(projectId: string | null, mode: "chat" | "code", title = "New chat"): Conversation {
  const now = new Date().toISOString(); return { id: crypto.randomUUID(), title, projectId, mode, messages: [], createdAt: now, updatedAt: now };
}

function bytesToB64(bytes: Uint8Array): string { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function b64ToBytes(value: string): Uint8Array { const raw = atob(value); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); }
async function cryptoKey(env: Env): Promise<CryptoKey> { if (!env.MASTER_KEY) throw new Error("MASTER_KEY is not configured"); const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.MASTER_KEY)); return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]); }

export async function encryptSecret(env: Env, value: string): Promise<{ ciphertext: string; iv: string }> { const key = await cryptoKey(env); const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value)); return { ciphertext: bytesToB64(new Uint8Array(encrypted)), iv: bytesToB64(iv) }; }
export async function decryptSecret(env: Env, record: SecretRecord): Promise<string> { const key = await cryptoKey(env); const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(record.iv) }, key, b64ToBytes(record.ciphertext)); return new TextDecoder().decode(decrypted); }

export async function putProjectSecret(env: Env, projectId: string, name: string, value: string): Promise<void> {
  const key = `project:${projectId}:secrets`; const records = (await getJson<SecretRecord[]>(env, key)) || []; const encrypted = await encryptSecret(env, value); const now = new Date().toISOString(); const existing = records.find((r) => r.name === name); const record: SecretRecord = { name, ...encrypted, createdAt: existing?.createdAt || now, updatedAt: now }; await putJson(env, key, [record, ...records.filter((r) => r.name !== name)]);
}
export async function listProjectSecrets(env: Env, projectId: string): Promise<Array<{ name: string; createdAt: string; updatedAt: string }>> { const records = (await getJson<SecretRecord[]>(env, `project:${projectId}:secrets`)) || []; return records.map(({ name, createdAt, updatedAt }) => ({ name, createdAt, updatedAt })); }
export async function getProjectSecret(env: Env, projectId: string, name: string): Promise<string | null> { const records = (await getJson<SecretRecord[]>(env, `project:${projectId}:secrets`)) || []; const record = records.find((r) => r.name === name); return record ? decryptSecret(env, record) : null; }
export async function deleteProjectSecret(env: Env, projectId: string, name: string): Promise<void> { const key = `project:${projectId}:secrets`; const records = (await getJson<SecretRecord[]>(env, key)) || []; await putJson(env, key, records.filter((r) => r.name !== name)); }
