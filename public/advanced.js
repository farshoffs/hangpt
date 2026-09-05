const token = sessionStorage.getItem("hangpt_token") || "";
if (!token) location.href = "/";

const $ = (s) => document.querySelector(s);
let projects = [], agents = [], memories = [], uploads = [];

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(path, { ...options, headers });
  const type = res.headers.get("content-type") || "";
  if (!res.ok) {
    let error = `Request failed (${res.status})`;
    try { const data = await res.json(); error = data.error || error; } catch { error = await res.text() || error; }
    throw new Error(error);
  }
  return type.includes("application/json") ? res.json() : res;
}

function esc(v="") { return String(v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"})[c]); }
function out(id, value) { $(id).textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function options(list, includeBlank = true) { return `${includeBlank ? '<option value="">Select project</option>' : ''}${list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}`; }

async function load() {
  const [caps, ps, as, ms, us] = await Promise.all([api("/api/capabilities"), api("/api/projects"), api("/api/agents"), api("/api/memories"), api("/api/uploads")]);
  projects = ps; agents = as; memories = ms; uploads = us;
  $("#caps").innerHTML = Object.entries({ OpenAI: caps.openai, GitHub: caps.github, "Encrypted secrets": caps.encryptedSecrets, "Cloudflare Access": caps.cloudflareAccessRequired }).map(([k,v]) => `<span class="cap">${esc(k)}: ${v ? "on" : "off"}</span>`).join("");
  $("#memory-project").innerHTML = options(projects);
  $("#upload-project").innerHTML = '<option value="">No project</option>' + projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  $("#ops-project").innerHTML = options(projects);
  $("#project-agent").innerHTML = '<option value="">No default agent</option>' + agents.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("");
  render();
}

function render() {
  $("#memory-list").innerHTML = memories.length ? memories.map(m => `<div class="item"><strong>${esc(m.text)}</strong><small>${esc(m.scope)}${m.projectId ? ` · ${esc(projects.find(p=>p.id===m.projectId)?.name || m.projectId)}` : ""}</small><button class="danger ghost" data-memory-delete="${m.id}">Delete</button></div>`).join("") : '<div class="item"><small>No saved memory yet.</small></div>';
  $("#agent-list").innerHTML = agents.length ? agents.map(a => `<div class="item"><strong>${esc(a.name)}</strong><small>${esc(a.model)} · ${esc(a.reasoning)} · ${esc(a.tools.join(", ") || "no tools")}</small><button class="danger ghost" data-agent-delete="${a.id}">Delete</button></div>`).join("") : '<div class="item"><small>No agents yet.</small></div>';
  $("#upload-list").innerHTML = uploads.length ? uploads.slice(0,20).map(u => `<div class="item"><strong>${esc(u.name)}</strong><small>${u.bytes} bytes · ${esc(u.type)}</small>${u.openaiFileId ? `<small>OpenAI: ${esc(u.openaiFileId)}</small>` : `<button class="secondary" data-upload-openai="${u.id}">Send to OpenAI Files</button>`}<button class="danger ghost" data-upload-delete="${u.id}">Delete</button></div>`).join("") : '<div class="item"><small>No uploads yet.</small></div>';
}

$("#memory-form").addEventListener("submit", async e => {
  e.preventDefault(); const scope = $("#memory-scope").value; const projectId = $("#memory-project").value;
  if (scope === "project" && !projectId) return alert("Select a project for project memory.");
  await api("/api/memories", { method:"POST", body:JSON.stringify({ text:$("#memory-text").value, scope, projectId }) }); $("#memory-text").value=""; memories = await api("/api/memories"); render();
});

$("#agent-form").addEventListener("submit", async e => {
  e.preventDefault(); await api("/api/agents", { method:"POST", body:JSON.stringify({ name:$("#agent-name").value, instructions:$("#agent-instructions").value, model:$("#agent-model").value, reasoning:$("#agent-reasoning").value, tools:$("#agent-web").checked ? ["web_search"] : [] }) }); e.target.reset(); agents = await api("/api/agents"); $("#project-agent").innerHTML = '<option value="">No default agent</option>' + agents.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join(""); render();
});

$("#upload-form").addEventListener("submit", async e => {
  e.preventDefault(); const file = $("#upload-file").files[0]; if (!file) return; const form = new FormData(); form.set("file", file); if ($("#upload-project").value) form.set("projectId", $("#upload-project").value); await api("/api/uploads", { method:"POST", body:form }); e.target.reset(); uploads = await api("/api/uploads"); render();
});

$("#image-form").addEventListener("submit", async e => {
  e.preventDefault(); out("#media-output", "Generating image…"); try { const data = await api("/api/media/image", { method:"POST", body:JSON.stringify({ prompt:$("#image-prompt").value }) }); const item = data.data?.[0] || {}; const src = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : ""); $("#media-output").innerHTML = src ? `<div class="media-preview"><img src="${src}" alt="Generated image" /></div>` : `<pre>${esc(JSON.stringify(data,null,2))}</pre>`; } catch(err) { out("#media-output", err.message); }
});

$("#speech-form").addEventListener("submit", async e => {
  e.preventDefault(); out("#media-output", "Generating speech…"); try { const res = await api("/api/media/speech", { method:"POST", body:JSON.stringify({ input:$("#speech-text").value, voice:$("#speech-voice").value }) }); const blob = await res.blob(); const url = URL.createObjectURL(blob); $("#media-output").innerHTML = `<audio controls autoplay src="${url}"></audio>`; } catch(err) { out("#media-output", err.message); }
});

$("#transcribe-form").addEventListener("submit", async e => {
  e.preventDefault(); const file = $("#audio-file").files[0]; if (!file) return; const form = new FormData(); form.set("file", file); out("#media-output", "Transcribing…"); try { out("#media-output", await api("/api/media/transcribe", { method:"POST", body:form })); } catch(err) { out("#media-output", err.message); }
});

$("#ops-project").addEventListener("change", async () => {
  const id = $("#ops-project").value; if (!id) return; try { const settings = await api(`/api/projects/${encodeURIComponent(id)}/settings`); $("#github-repo").value = settings.github?.repo || ""; $("#github-branch").value = settings.github?.branch || "main"; $("#project-model").value = settings.defaultModel || ""; $("#project-agent").value = settings.agentId || ""; $("#project-memory").checked = settings.memoryEnabled !== false; $("#project-web").checked = settings.webSearch === true; const secrets = await api(`/api/projects/${encodeURIComponent(id)}/secrets`); out("#ops-output", { settings, secrets }); } catch(err) { out("#ops-output", err.message); }
});

$("#settings-form").addEventListener("submit", async e => {
  e.preventDefault(); const id = $("#ops-project").value; if (!id) return alert("Select a project."); const repo = $("#github-repo").value.trim(); const payload = { defaultModel:$("#project-model").value || undefined, agentId:$("#project-agent").value || null, memoryEnabled:$("#project-memory").checked, webSearch:$("#project-web").checked, github:repo ? { repo, branch:$("#github-branch").value.trim() || "main" } : null }; out("#ops-output", await api(`/api/projects/${encodeURIComponent(id)}/settings`, { method:"PUT", body:JSON.stringify(payload) }));
});

$("#secret-form").addEventListener("submit", async e => {
  e.preventDefault(); const id = $("#ops-project").value; if (!id) return alert("Select a project."); try { const result = await api(`/api/projects/${encodeURIComponent(id)}/secrets`, { method:"POST", body:JSON.stringify({ name:$("#secret-name").value, value:$("#secret-value").value }) }); $("#secret-value").value=""; out("#ops-output", result); } catch(err) { out("#ops-output", err.message); }
});

$("#exec-form").addEventListener("submit", async e => {
  e.preventDefault(); const id = $("#ops-project").value; if (!id) return alert("Select a project."); try { out("#ops-output", await api(`/api/projects/${encodeURIComponent(id)}/execute`, { method:"POST", body:JSON.stringify({ task:$("#exec-task").value }) })); } catch(err) { out("#ops-output", err.message); }
});

$("#memory-list").addEventListener("click", async e => { const b=e.target.closest("[data-memory-delete]"); if (!b) return; await api(`/api/memories/${b.dataset.memoryDelete}`, {method:"DELETE"}); memories=await api("/api/memories"); render(); });
$("#agent-list").addEventListener("click", async e => { const b=e.target.closest("[data-agent-delete]"); if (!b) return; await api(`/api/agents/${b.dataset.agentDelete}`, {method:"DELETE"}); agents=await api("/api/agents"); render(); });
$("#upload-list").addEventListener("click", async e => { const del=e.target.closest("[data-upload-delete]"); const send=e.target.closest("[data-upload-openai]"); if(del){await api(`/api/uploads/${del.dataset.uploadDelete}`,{method:"DELETE"}); uploads=await api("/api/uploads"); render();} if(send){try{const r=await api(`/api/uploads/${send.dataset.uploadOpenai}/openai`,{method:"POST"}); out("#media-output",r); uploads=await api("/api/uploads"); render();}catch(err){out("#media-output",err.message);}} });

load().catch(err => { document.body.innerHTML = `<main class="advanced-shell"><h1>Unable to open Advanced workspace</h1><p class="danger-text">${esc(err.message)}</p><a href="/">Return to HanGPT</a></main>`; });
