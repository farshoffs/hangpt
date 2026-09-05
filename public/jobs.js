const $ = (s) => document.querySelector(s);
const state = { token: sessionStorage.getItem("hangpt_token") || "", jobs: [], projects: [], activeId: null };
const cacheKey = "hangpt_jobs_cache_v1";

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error || data.raw || `Request failed (${response.status})`);
  return data;
}

function setAuthVisible(show) { $("#auth-mini").classList.toggle("hidden", !show); }

async function connect(token) {
  state.token = token.trim();
  if (!state.token) return;
  sessionStorage.setItem("hangpt_token", state.token);
  try {
    await loadProjects();
    await loadJobs();
    setAuthVisible(false);
  } catch (error) {
    setAuthVisible(true);
    throw error;
  }
}

async function loadProjects() {
  state.projects = await api("/api/projects");
  $("#project").innerHTML = `<option value="">No project</option>${state.projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}`;
}

async function loadJobs() {
  if (!navigator.onLine) return loadCachedJobs();
  state.jobs = await api("/api/jobs");
  localStorage.setItem(cacheKey, JSON.stringify(state.jobs));
  renderJobs();
  if (state.activeId) await openJob(state.activeId, false);
}

function loadCachedJobs() {
  try { state.jobs = JSON.parse(localStorage.getItem(cacheKey) || "[]"); } catch { state.jobs = []; }
  renderJobs();
}

function renderJobs() {
  const root = $("#job-list");
  if (!state.jobs.length) { root.innerHTML = `<div class="empty">No cloud jobs yet.</div>`; return; }
  root.innerHTML = state.jobs.map((job) => {
    const current = Number(job.progress?.current || 0), total = Number(job.progress?.total || job.passes || 1);
    return `<article class="job-card ${state.activeId === job.id ? "active" : ""}" data-id="${escapeHtml(job.id)}"><h3>${escapeHtml(job.title || job.id)}</h3><div class="job-meta"><span class="status ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span><span>${current}/${total} passes</span><span>${new Date(job.updatedAt || job.createdAt).toLocaleString()}</span></div></article>`;
  }).join("");
}

async function openJob(id, updateList = true) {
  state.activeId = id;
  if (updateList) renderJobs();
  const detail = $("#job-detail");
  detail.classList.remove("hidden");
  if (!navigator.onLine) {
    const cached = state.jobs.find((j) => j.id === id);
    if (cached) renderDetail(cached, true);
    return;
  }
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    renderDetail(job, false);
    const i = state.jobs.findIndex((j) => j.id === id);
    const compact = { ...job }; delete compact.result; delete compact.partialResult; delete compact.prompt; delete compact.workflow;
    if (i >= 0) state.jobs[i] = compact; else state.jobs.unshift(compact);
    localStorage.setItem(cacheKey, JSON.stringify(state.jobs));
    renderJobs();
  } catch (error) { $("#result").textContent = `Error: ${error.message}`; }
}

function renderDetail(job, cached) {
  $("#detail-title").textContent = job.title || job.id;
  const workflowStatus = job.workflow?.status ? ` · workflow ${job.workflow.status}` : "";
  $("#detail-meta").textContent = `${job.model || ""} · ${job.reasoning || ""}${job.webSearch ? " · web" : ""}${cached ? " · cached/offline" : workflowStatus}`;
  const status = $("#detail-status");
  status.textContent = job.status || job.workflow?.status || "unknown";
  status.className = `status ${job.status || ""}`;
  const current = Number(job.progress?.current || 0), total = Math.max(1, Number(job.progress?.total || job.passes || 1));
  $("#progress-bar").style.width = `${Math.min(100, Math.round((current / total) * 100))}%`;
  $("#result").textContent = job.result || job.partialResult || job.error || (cached ? "Reconnect to fetch the latest result. The cloud job may still be running." : "Job is still running in Cloudflare. You may close this app.");
}

async function startJob() {
  const prompt = $("#prompt").value.trim();
  if (!prompt) return alert("Enter a task first.");
  if (!state.token) return setAuthVisible(true);
  const button = $("#start"); button.disabled = true; button.textContent = "Submitting…";
  try {
    const job = await api("/api/jobs", { method: "POST", body: JSON.stringify({
      prompt,
      projectId: $("#project").value || null,
      model: $("#model").value,
      reasoning: $("#reasoning").value,
      webSearch: $("#web").checked,
      passes: Number($("#passes").value),
    }) });
    $("#prompt").value = "";
    state.activeId = job.id;
    await loadJobs();
    await openJob(job.id);
    alert("Cloud job started. It will continue even if you close the app or lose internet.");
  } catch (error) { alert(error.message); }
  finally { button.disabled = false; button.textContent = "Start cloud job"; }
}

async function jobAction(action) {
  if (!state.activeId || !navigator.onLine) return;
  if (action === "terminate" && !confirm("Terminate this cloud job?")) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(state.activeId)}/${action}`, { method: "POST" });
    await openJob(state.activeId);
  } catch (error) { alert(error.message); }
}

function escapeHtml(value = "") { return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch]); }

$("#save-token").addEventListener("click", () => connect($("#token").value).catch((e) => alert(e.message)));
$("#start").addEventListener("click", startJob);
$("#refresh").addEventListener("click", () => loadJobs().catch((e) => alert(e.message)));
$("#job-list").addEventListener("click", (event) => { const card = event.target.closest("[data-id]"); if (card) openJob(card.dataset.id); });
$("#job-detail").addEventListener("click", (event) => { const btn = event.target.closest("[data-action]"); if (btn) jobAction(btn.dataset.action); });
window.addEventListener("online", () => { document.documentElement.classList.remove("offline"); if (state.token) loadJobs().catch(() => {}); });
window.addEventListener("offline", () => { document.documentElement.classList.add("offline"); loadCachedJobs(); if (state.activeId) openJob(state.activeId, false); });

(async function boot() {
  if (!navigator.onLine) document.documentElement.classList.add("offline");
  loadCachedJobs();
  if (!state.token) { setAuthVisible(true); return; }
  try { await connect(state.token); } catch { setAuthVisible(true); }
  setInterval(() => { if (navigator.onLine && state.token) loadJobs().catch(() => {}); }, 6000);
})();
