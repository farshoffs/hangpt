import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import type { Env, Project, MemoryItem, AgentProfile, CloudJob, BackgroundJobParams } from "./types";
import { bodyJson, cleanText, getJson, json, loadIndex, putJson, upsertIndex } from "./core";
import { chooseModel, chooseReasoning } from "./openai";

export async function handleBackgroundApi(request: Request, env: Env): Promise<Response> {
  if (!env.JOBS) return json({ error: "Cloud background jobs are not configured" }, 501);
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/jobs" && request.method === "GET") {
    const items = await loadIndex<CloudJob>(env, "jobs:index");
    return json(items.map(stripLargeFields));
  }

  if (path === "/api/jobs" && request.method === "POST") {
    const body = await bodyJson(request);
    const prompt = cleanText(body.prompt, "", 100_000).trim();
    if (!prompt) return json({ error: "prompt is required" }, 400);
    const passes = Math.max(1, Math.min(5, Number(body.passes) || 1));
    const now = new Date().toISOString();
    const id = `job_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
    const params: BackgroundJobParams = {
      jobId: id,
      prompt,
      title: cleanText(body.title, prompt.replace(/\s+/g, " ").slice(0, 80), 120),
      projectId: body.projectId ? String(body.projectId) : null,
      model: cleanText(body.model, "gpt-5.6", 50),
      reasoning: cleanText(body.reasoning, "medium", 20),
      webSearch: body.webSearch === true,
      passes,
    };
    const job: CloudJob = {
      id,
      title: params.title,
      prompt,
      projectId: params.projectId,
      model: params.model,
      reasoning: params.reasoning,
      webSearch: params.webSearch,
      passes,
      status: "queued",
      progress: { current: 0, total: passes },
      createdAt: now,
      updatedAt: now,
    };
    await saveJob(env, job);
    await env.JOBS.create({
      id,
      params,
      retention: { successRetention: "7 days", errorRetention: "14 days" },
    });
    return json({ id, status: "queued", cloud: true, message: "Job is running in Cloudflare and no longer depends on this browser connection." }, 202);
  }

  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && request.method === "GET") {
    const id = jobMatch[1];
    const job = await getJson<CloudJob>(env, `job:${id}`);
    if (!job) return json({ error: "Job not found" }, 404);
    let workflow: unknown = null;
    try {
      const instance = await env.JOBS.get(id);
      workflow = await instance.status();
    } catch {}
    return json({ ...job, workflow });
  }

  const actionMatch = path.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|restart|terminate)$/);
  if (actionMatch && request.method === "POST") {
    const [, id, action] = actionMatch;
    const job = await getJson<CloudJob>(env, `job:${id}`);
    if (!job) return json({ error: "Job not found" }, 404);
    const instance = await env.JOBS.get(id);
    if (action === "pause") await instance.pause();
    if (action === "resume") await instance.resume();
    if (action === "restart") await instance.restart();
    if (action === "terminate") await instance.terminate();
    job.status = action === "terminate" ? "terminated" : action === "pause" ? "paused" : action === "resume" ? "running" : "queued";
    job.updatedAt = new Date().toISOString();
    await saveJob(env, job);
    return json({ ok: true, id, action, status: await instance.status() });
  }

  return json({ error: "Not found" }, 404);
}

export class HanGPTWorkflow extends WorkflowEntrypoint<Env, BackgroundJobParams> {
  async run(event: WorkflowEvent<BackgroundJobParams>, step: WorkflowStep) {
    const params = event.payload;
    await step.do("mark running", async () => {
      const job = await requireJob(this.env, params.jobId);
      job.status = "running";
      job.startedAt ||= new Date().toISOString();
      job.updatedAt = new Date().toISOString();
      await saveJob(this.env, job);
      return true;
    });

    try {
      const context = await step.do("load workspace context", async () => loadWorkspaceContext(this.env, params.projectId));
      let result = "";
      for (let index = 0; index < params.passes; index++) {
        result = await step.do(
          `AI pass ${index + 1}`,
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => runBackgroundAI(this.env, params, context, result, index),
        );
        const passResult = result;
        await step.do(`save progress ${index + 1}`, async () => {
          const job = await requireJob(this.env, params.jobId);
          job.partialResult = passResult.slice(0, 120_000);
          job.progress = { current: index + 1, total: params.passes };
          job.updatedAt = new Date().toISOString();
          await saveJob(this.env, job);
          return true;
        });
      }

      const finalResult = result;
      await step.do("save completed result", async () => {
        const job = await requireJob(this.env, params.jobId);
        job.status = "complete";
        job.result = finalResult.slice(0, 200_000);
        job.partialResult = undefined;
        job.progress = { current: params.passes, total: params.passes };
        job.completedAt = new Date().toISOString();
        job.updatedAt = job.completedAt;
        await saveJob(this.env, job);
        return true;
      });
      return { jobId: params.jobId, result: finalResult.slice(0, 200_000) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Background job failed";
      await step.do("record job error", async () => {
        const job = await requireJob(this.env, params.jobId);
        job.status = "errored";
        job.error = message.slice(0, 4000);
        job.updatedAt = new Date().toISOString();
        await saveJob(this.env, job);
        return true;
      });
      throw error;
    }
  }
}

type WorkspaceContext = {
  project: { name: string; instructions: string } | null;
  memories: string[];
  agent: { name: string; instructions: string } | null;
};

async function loadWorkspaceContext(env: Env, projectId: string | null): Promise<WorkspaceContext> {
  const project = projectId ? await getJson<Project>(env, `project:${projectId}`) : null;
  const memories = await loadIndex<MemoryItem>(env, "memories:index");
  const relevant = memories.filter((m) => m.scope === "global" || (projectId && m.projectId === projectId)).slice(0, 50);
  let agent: AgentProfile | null = null;
  const agentId = project?.settings?.agentId;
  if (agentId) agent = (await loadIndex<AgentProfile>(env, "agents:index")).find((a) => a.id === agentId) || null;
  return {
    project: project ? { name: project.name, instructions: project.instructions } : null,
    memories: relevant.map((m) => m.text),
    agent: agent ? { name: agent.name, instructions: agent.instructions } : null,
  };
}

async function runBackgroundAI(env: Env, params: BackgroundJobParams, context: WorkspaceContext, previous: string, passIndex: number): Promise<string> {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const model = chooseModel(params.model, env.OPENAI_MODEL);
  const reasoning = chooseReasoning(params.reasoning);
  let instructions = "You are HanGPT Cloud, a durable background AI worker. Complete the requested task thoroughly. The user may be offline, so do not ask follow-up questions unless absolutely unavoidable; make sensible assumptions and produce a self-contained result.";
  if (context.project) instructions += `\n\nProject: ${context.project.name}\nProject instructions:\n${context.project.instructions || "No extra project instructions."}`;
  if (context.memories.length) instructions += `\n\nRelevant saved memory:\n${context.memories.map((m) => `- ${m}`).join("\n")}`;
  if (context.agent) instructions += `\n\nActive agent: ${context.agent.name}\n${context.agent.instructions}`;

  const prompt = passIndex === 0
    ? params.prompt
    : `Original task:\n${params.prompt}\n\nPrevious draft from pass ${passIndex}:\n${previous.slice(0, 100_000)}\n\nThis is pass ${passIndex + 1} of ${params.passes}. Improve, verify, correct, and complete the draft. Return the full replacement result, not a critique.`;
  const payload: any = {
    model,
    instructions,
    reasoning: { effort: reasoning },
    text: { verbosity: "medium" },
    input: [{ role: "user", content: prompt }],
  };
  if (params.webSearch) payload.tools = [{ type: "web_search" }];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json<any>();
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI background request failed (${response.status})`);
  const text = extractOutputText(data);
  if (!text) throw new Error("OpenAI returned an empty background result");
  return text;
}

function extractOutputText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  const chunks: string[] = [];
  for (const item of response?.output || []) for (const content of item?.content || []) if (content?.type === "output_text" && content.text) chunks.push(content.text);
  return chunks.join("\n");
}

async function requireJob(env: Env, id: string): Promise<CloudJob> {
  const job = await getJson<CloudJob>(env, `job:${id}`);
  if (!job) throw new Error(`Job ${id} not found`);
  return job;
}

async function saveJob(env: Env, job: CloudJob): Promise<void> {
  await putJson(env, `job:${job.id}`, job);
  await upsertIndex(env, "jobs:index", stripLargeFields(job));
}

function stripLargeFields(job: CloudJob): CloudJob {
  const copy = { ...job };
  delete copy.result;
  delete copy.partialResult;
  delete copy.prompt;
  return copy;
}
