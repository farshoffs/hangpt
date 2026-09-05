export interface Env {
  DATA: KVNamespace;
  ASSETS: Fetcher;
  DB?: D1Database;
  FILES?: R2Bucket;
  JOBS?: any;
  OPENAI_API_KEY: string;
  APP_TOKEN: string;
  OPENAI_MODEL?: string;
  MASTER_KEY?: string;
  GITHUB_TOKEN?: string;
  CF_ACCESS_REQUIRED?: string;
  CF_ACCESS_EMAIL_HEADER?: string;
}

export type Role = "user" | "assistant";
export type Message = { role: Role; content: string; createdAt: string; attachments?: string[] };
export type GitHubConfig = { repo: string; branch: string };
export type ProjectSettings = { defaultModel?: string; reasoning?: string; webSearch?: boolean; memoryEnabled?: boolean; agentId?: string | null; github?: GitHubConfig | null };
export type Project = { id: string; name: string; instructions: string; files: Record<string, string>; settings?: ProjectSettings; createdAt: string; updatedAt: string };
export type ProjectMeta = Omit<Project, "files"> & { fileNames: string[] };
export type Conversation = { id: string; title: string; projectId: string | null; mode: "chat" | "code"; messages: Message[]; createdAt: string; updatedAt: string };
export type ConversationMeta = Omit<Conversation, "messages"> & { messageCount: number };
export type OAuthConfig = { authorizationUrl: string; tokenUrl: string; clientId: string; scopes?: string[] };
export type PluginManifest = { id: string; name: string; description: string; url: string; authType?: "none" | "bearer" | "header" | "oauth2"; authHeader?: string; secretRef?: string; oauth?: OAuthConfig; createdAt: string };
export type MemoryItem = { id: string; text: string; scope: "global" | "project"; projectId?: string | null; tags: string[]; createdAt: string; updatedAt: string };
export type AgentProfile = { id: string; name: string; description: string; instructions: string; model: string; reasoning: string; tools: string[]; createdAt: string; updatedAt: string };
export type UploadMeta = { id: string; name: string; type: string; bytes: number; projectId: string | null; openaiFileId?: string | null; createdAt: string };
export type SecretRecord = { name: string; ciphertext: string; iv: string; createdAt: string; updatedAt: string };

export type BackgroundJobParams = {
  jobId: string;
  prompt: string;
  title: string;
  projectId: string | null;
  model: string;
  reasoning: string;
  webSearch: boolean;
  passes: number;
};

export type CloudJobStatus = "queued" | "running" | "paused" | "complete" | "errored" | "terminated";
export type CloudJob = {
  id: string;
  title: string;
  prompt?: string;
  projectId: string | null;
  model: string;
  reasoning: string;
  webSearch: boolean;
  passes: number;
  status: CloudJobStatus;
  progress: { current: number; total: number };
  result?: string;
  partialResult?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};
