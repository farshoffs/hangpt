const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  token: sessionStorage.getItem("hangpt_token") || "",
  projects: [],
  conversations: [],
  plugins: [],
  currentConversation: null,
  codeProject: null,
  codeConversations: {},
  activeFile: "",
  activePlugin: null,
  busy: false,
};

const els = {
  app: $("#app"), auth: $("#auth-overlay"), authForm: $("#auth-form"), authToken: $("#auth-token"), authError: $("#auth-error"),
  sidebar: $("#sidebar"), backdrop: $("#sidebar-backdrop"), viewTitle: $("#view-title"), chatControls: $("#chat-controls"),
  messages: $("#messages"), emptyChat: $("#empty-chat"), composer: $("#composer"), input: $("#message-input"), send: $("#send-message"),
  projectSelect: $("#project-select"), model: $("#model-select"), reasoning: $("#reasoning-select"), web: $("#web-search"), context: $("#context-label"),
  conversations: $("#conversation-list"), projectGrid: $("#project-grid"), projectCount: $("#project-count"),
  projectForm: $("#project-form"), projectName: $("#project-name"), projectInstructions: $("#project-instructions"),
  codeProjectSelect: $("#code-project-select"), codeStatus: $("#code-status"), fileList: $("#file-list"), filePath: $("#file-path"), fileEditor: $("#file-editor"),
  codeForm: $("#code-form"), codePrompt: $("#code-prompt"), codeLog: $("#code-log"), codeWeb: $("#code-web-search"),
  pluginForm: $("#plugin-form"), pluginList: $("#plugin-list"), pluginCount: $("#plugin-count"), pluginRunner: $("#plugin-runner"), runnerName: $("#runner-name"),
  pluginPayload: $("#plugin-payload"), pluginHeaders: $("#plugin-headers"), pluginResult: $("#plugin-result"), toast: $("#toast"),
};

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${state.token}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error || data.body || data.raw || `Request failed (${response.status})`);
  return data;
}

async function connect(token) {
  state.token = token.trim();
  if (!state.token) throw new Error("Token is required");
  await api("/api/projects");
  sessionStorage.setItem("hangpt_token", state.token);
  els.auth.classList.add("hidden");
  els.app.classList.remove("hidden");
  await loadAll();
}

async function loadAll() {
  const [projects, conversations, plugins] = await Promise.all([
    api("/api/projects"), api("/api/conversations"), api("/api/plugins"),
  ]);
  state.projects = projects;
  state.conversations = conversations;
  state.plugins = plugins;
  renderProjects();
  renderConversations();
  renderPlugins();
}

function showView(name) {
  $$(".view").forEach((el) => el.classList.toggle("active", el.id === `view-${name}`));
  $$("[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === name && el.classList.contains("nav-item")));
  els.viewTitle.textContent = ({ chat: "Chat", projects: "Projects", code: "Code", plugins: "Plugins" })[name] || "HanGPT";
  els.chatControls.style.display = name === "chat" ? "flex" : "none";
  closeSidebar();
  if (name === "code" && !state.codeProject && state.projects.length === 1) {
    els.codeProjectSelect.value = state.projects[0].id;
    loadCodeProject(state.projects[0].id);
  }
}

function closeSidebar() {
  els.sidebar.classList.remove("open");
  els.backdrop.style.display = "none";
}

function openSidebar() {
  els.sidebar.classList.add("open");
  els.backdrop.style.display = "block";
}

function renderConversations() {
  els.conversations.innerHTML = state.conversations.length ? state.conversations.map((c) => `
    <button class="conversation ${state.currentConversation?.id === c.id ? "active" : ""}" data-conversation="${escapeAttr(c.id)}" title="${escapeAttr(c.title)}">${escapeHtml(c.title)}</button>
  `).join("") : `<div class="agent-empty">No chats yet</div>`;
}

async function openConversation(id) {
  try {
    state.currentConversation = await api(`/api/conversations/${encodeURIComponent(id)}`);
    els.projectSelect.value = state.currentConversation.projectId || "";
    renderChat();
    renderConversations();
    showView("chat");
  } catch (error) { toast(error.message); }
}

function newChat() {
  state.currentConversation = null;
  renderConversations();
  renderChat();
  showView("chat");
  els.input.focus();
}

function renderChat() {
  const messages = state.currentConversation?.messages || [];
  els.emptyChat.style.display = messages.length ? "none" : "grid";
  els.messages.innerHTML = messages.map(messageHtml).join("");
  requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
  updateContextLabel();
}

function messageHtml(message) {
  const user = message.role === "user";
  return `<article class="message ${user ? "user" : "assistant"}">
    <div class="avatar">${user ? "You" : "H"}</div>
    <div class="message-content">${formatText(message.content)}</div>
  </article>`;
}

function appendPending() {
  els.emptyChat.style.display = "none";
  els.messages.insertAdjacentHTML("beforeend", `<article id="pending" class="message assistant"><div class="avatar">H</div><div class="message-content"><span class="loading-dots"><i></i><i></i><i></i></span></div></article>`);
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function sendChat(text) {
  if (state.busy || !text.trim()) return;
  state.busy = true;
  els.send.disabled = true;
  const optimistic = { role: "user", content: text.trim() };
  els.emptyChat.style.display = "none";
  els.messages.insertAdjacentHTML("beforeend", messageHtml(optimistic));
  appendPending();
  els.input.value = "";
  resizeComposer();

  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: state.currentConversation?.id || null,
        projectId: els.projectSelect.value || null,
        mode: "chat",
        message: text.trim(),
        model: els.model.value,
        reasoning: els.reasoning.value,
        webSearch: els.web.checked,
      }),
    });
    state.currentConversation = result.conversation;
    await refreshConversations();
    renderChat();
  } catch (error) {
    $("#pending")?.remove();
    els.messages.insertAdjacentHTML("beforeend", messageHtml({ role: "assistant", content: `Error: ${error.message}` }));
    toast(error.message);
  } finally {
    state.busy = false;
    els.send.disabled = false;
    els.input.focus();
  }
}

async function refreshConversations() {
  state.conversations = await api("/api/conversations");
  renderConversations();
}

function renderProjects() {
  const currentChatProject = els.projectSelect.value;
  const currentCodeProject = els.codeProjectSelect.value;
  const options = state.projects.map((p) => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  els.projectSelect.innerHTML = `<option value="">No project</option>${options}`;
  els.codeProjectSelect.innerHTML = `<option value="">Select a project</option>${options}`;
  if (state.projects.some((p) => p.id === currentChatProject)) els.projectSelect.value = currentChatProject;
  else if (state.currentConversation?.projectId) els.projectSelect.value = state.currentConversation.projectId;
  if (state.projects.some((p) => p.id === currentCodeProject)) els.codeProjectSelect.value = currentCodeProject;
  els.projectCount.textContent = state.projects.length;
  els.projectGrid.innerHTML = state.projects.length ? state.projects.map((p) => `
    <article class="project-card">
      <h4>${escapeHtml(p.name)}</h4>
      <p>${escapeHtml((p.instructions || "No custom instructions").slice(0, 160))}</p>
      <div class="meta"><span>${p.fileNames?.length || 0} files</span><div class="card-actions"><button data-project-chat="${p.id}">Chat</button><button data-project-code="${p.id}">Code</button><button data-project-delete="${p.id}">Delete</button></div></div>
    </article>
  `).join("") : `<div class="agent-empty">Create your first project to add persistent instructions and a code workspace.</div>`;
  updateContextLabel();
}

async function createProject(name, instructions) {
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name, instructions }) });
  state.projects = await api("/api/projects");
  renderProjects();
  toast("Project created");
}

async function deleteProject(id) {
  if (!confirm("Delete this project and its virtual files? Chats are kept.")) return;
  await api(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  state.projects = await api("/api/projects");
  if (state.codeProject?.id === id) clearCodeProject();
  renderProjects();
  toast("Project deleted");
}

function updateContextLabel() {
  const project = state.projects.find((p) => p.id === els.projectSelect.value);
  els.context.textContent = project ? `Project · ${project.name}` : "General chat";
}

async function loadCodeProject(id) {
  if (!id) { clearCodeProject(); return; }
  try {
    state.codeProject = await api(`/api/projects/${encodeURIComponent(id)}`);
    state.activeFile = "";
    els.filePath.value = "";
    els.fileEditor.value = "";
    renderFileList();
    els.codeStatus.textContent = `${Object.keys(state.codeProject.files || {}).length} files · agent ready`;
  } catch (error) { toast(error.message); }
}

function clearCodeProject() {
  state.codeProject = null;
  state.activeFile = "";
  els.fileList.innerHTML = "";
  els.filePath.value = "";
  els.fileEditor.value = "";
  els.codeStatus.textContent = "Choose a project to start";
}

function renderFileList() {
  if (!state.codeProject) { els.fileList.innerHTML = ""; return; }
  const files = Object.keys(state.codeProject.files || {}).sort();
  els.fileList.innerHTML = files.length ? files.map((path) => `<button class="file-item ${path === state.activeFile ? "active" : ""}" data-file="${escapeAttr(path)}">${escapeHtml(path)}</button>`).join("") : `<div class="agent-empty">No files yet</div>`;
  els.codeStatus.textContent = `${files.length} files · agent ready`;
}

function openFile(path) {
  if (!state.codeProject || !(path in state.codeProject.files)) return;
  state.activeFile = path;
  els.filePath.value = path;
  els.fileEditor.value = state.codeProject.files[path];
  renderFileList();
}

async function saveFile() {
  if (!state.codeProject) return toast("Select a project first");
  const path = els.filePath.value.trim();
  if (!path) return toast("Enter a file path");
  try {
    await api(`/api/projects/${encodeURIComponent(state.codeProject.id)}/files`, { method: "PUT", body: JSON.stringify({ path, content: els.fileEditor.value }) });
    state.codeProject = await api(`/api/projects/${encodeURIComponent(state.codeProject.id)}`);
    state.activeFile = path;
    renderFileList();
    await refreshProjectsOnly();
    toast("File saved");
  } catch (error) { toast(error.message); }
}

async function deleteFile() {
  if (!state.codeProject || !state.activeFile) return;
  if (!confirm(`Delete ${state.activeFile}?`)) return;
  try {
    await api(`/api/projects/${encodeURIComponent(state.codeProject.id)}/files?path=${encodeURIComponent(state.activeFile)}`, { method: "DELETE" });
    state.codeProject = await api(`/api/projects/${encodeURIComponent(state.codeProject.id)}`);
    state.activeFile = "";
    els.filePath.value = "";
    els.fileEditor.value = "";
    renderFileList();
    await refreshProjectsOnly();
    toast("File deleted");
  } catch (error) { toast(error.message); }
}

async function refreshProjectsOnly() {
  state.projects = await api("/api/projects");
  renderProjects();
  if (state.codeProject) els.codeProjectSelect.value = state.codeProject.id;
}

function addCodeLog(role, text, pending = false) {
  if ($(".agent-empty", els.codeLog)) els.codeLog.innerHTML = "";
  const id = pending ? ` id="code-pending"` : "";
  const content = pending ? `<span class="loading-dots"><i></i><i></i><i></i></span>` : formatText(text);
  els.codeLog.insertAdjacentHTML("beforeend", `<div class="agent-entry"${id}><strong>${role}</strong>${content}</div>`);
  els.codeLog.scrollTop = els.codeLog.scrollHeight;
}

async function runCodeAgent(prompt) {
  if (state.busy) return;
  if (!state.codeProject) return toast("Select a project first");
  if (!prompt.trim()) return;
  state.busy = true;
  addCodeLog("You", prompt);
  addCodeLog("Agent", "", true);
  els.codePrompt.value = "";
  try {
    const projectId = state.codeProject.id;
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: state.codeConversations[projectId] || null,
        projectId,
        mode: "code",
        message: prompt.trim(),
        model: els.model.value,
        reasoning: els.reasoning.value,
        webSearch: els.codeWeb.checked,
      }),
    });
    state.codeConversations[projectId] = result.conversation.id;
    state.codeProject = result.project || await api(`/api/projects/${encodeURIComponent(projectId)}`);
    $("#code-pending")?.remove();
    addCodeLog("Agent", result.text);
    renderFileList();
    if (state.activeFile && state.codeProject.files[state.activeFile] !== undefined) els.fileEditor.value = state.codeProject.files[state.activeFile];
    await Promise.all([refreshProjectsOnly(), refreshConversations()]);
  } catch (error) {
    $("#code-pending")?.remove();
    addCodeLog("Error", error.message);
    toast(error.message);
  } finally { state.busy = false; }
}

function renderPlugins() {
  els.pluginCount.textContent = state.plugins.length;
  els.pluginList.innerHTML = state.plugins.length ? state.plugins.map((p) => `
    <article class="plugin-card">
      <h4>${escapeHtml(p.name)}</h4><p>${escapeHtml(p.description || "No description")}</p><div class="url">${escapeHtml(p.url)}</div>
      <div class="meta"><span>HTTPS webhook</span><div class="card-actions"><button data-plugin-run="${p.id}">Run</button><button data-plugin-delete="${p.id}">Delete</button></div></div>
    </article>
  `).join("") : `<div class="agent-empty">No plugins registered yet.</div>`;
}

async function createPlugin(name, url, description) {
  await api("/api/plugins", { method: "POST", body: JSON.stringify({ name, url, description }) });
  state.plugins = await api("/api/plugins");
  renderPlugins();
  toast("Plugin added");
}

function openPluginRunner(id) {
  state.activePlugin = state.plugins.find((p) => p.id === id) || null;
  if (!state.activePlugin) return;
  els.runnerName.textContent = state.activePlugin.name;
  els.pluginPayload.value = "{}";
  els.pluginHeaders.value = "{}";
  els.pluginResult.textContent = "Result will appear here.";
  els.pluginRunner.classList.remove("hidden");
  els.pluginRunner.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function runPlugin() {
  if (!state.activePlugin) return;
  try {
    const payload = JSON.parse(els.pluginPayload.value || "{}");
    const headers = JSON.parse(els.pluginHeaders.value || "{}");
    els.pluginResult.textContent = "Calling endpoint…";
    const result = await api(`/api/plugins/${encodeURIComponent(state.activePlugin.id)}/call`, { method: "POST", body: JSON.stringify({ payload, headers }) });
    let body = result.body;
    try { body = JSON.stringify(JSON.parse(result.body), null, 2); } catch {}
    els.pluginResult.textContent = `HTTP ${result.status}\n\n${body}`;
  } catch (error) { els.pluginResult.textContent = `Error\n\n${error.message}`; }
}

function formatText(text = "") {
  const parts = String(text).split("```");
  return parts.map((part, index) => {
    if (index % 2) {
      const firstBreak = part.indexOf("\n");
      const code = firstBreak >= 0 ? part.slice(firstBreak + 1) : part;
      return `<pre><code>${escapeHtml(code)}</code></pre>`;
    }
    let safe = escapeHtml(part);
    safe = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
    safe = safe.replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br>");
    return `<p>${safe}</p>`;
  }).join("");
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch]);
}
function escapeAttr(value = "") { return escapeHtml(value); }

let toastTimer;
function toast(message) {
  els.toast.textContent = String(message).slice(0, 220);
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2400);
}

function resizeComposer() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(180, els.input.scrollHeight)}px`;
}

els.authForm.addEventListener("submit", async (event) => {
  event.preventDefault(); els.authError.textContent = "";
  try { await connect(els.authToken.value); } catch (error) { els.authError.textContent = error.message; }
});
els.composer.addEventListener("submit", (event) => { event.preventDefault(); sendChat(els.input.value); });
els.input.addEventListener("input", resizeComposer);
els.input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); els.composer.requestSubmit(); } });
els.projectSelect.addEventListener("change", updateContextLabel);
els.projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await createProject(els.projectName.value, els.projectInstructions.value); els.projectForm.reset(); } catch (error) { toast(error.message); }
});
els.codeProjectSelect.addEventListener("change", (event) => loadCodeProject(event.target.value));
els.codeForm.addEventListener("submit", (event) => { event.preventDefault(); runCodeAgent(els.codePrompt.value); });
els.pluginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await createPlugin($("#plugin-name").value, $("#plugin-url").value, $("#plugin-description").value); els.pluginForm.reset(); } catch (error) { toast(error.message); }
});

$("#new-chat").addEventListener("click", newChat);
$("#refresh-chats").addEventListener("click", async () => { try { await refreshConversations(); toast("Chats refreshed"); } catch (error) { toast(error.message); } });
$("#logout").addEventListener("click", () => { sessionStorage.removeItem("hangpt_token"); location.reload(); });
$("#open-sidebar").addEventListener("click", openSidebar);
$("#close-sidebar").addEventListener("click", closeSidebar);
els.backdrop.addEventListener("click", closeSidebar);
$("#save-file").addEventListener("click", saveFile);
$("#delete-file").addEventListener("click", deleteFile);
$("#refresh-files").addEventListener("click", () => state.codeProject && loadCodeProject(state.codeProject.id));
$("#new-file").addEventListener("click", () => {
  if (!state.codeProject) return toast("Select a project first");
  const path = prompt("New relative file path", "src/index.ts");
  if (!path) return;
  state.activeFile = path.trim(); els.filePath.value = state.activeFile; els.fileEditor.value = ""; els.fileEditor.focus(); renderFileList();
});
$("#run-plugin").addEventListener("click", runPlugin);
$("#close-runner").addEventListener("click", () => els.pluginRunner.classList.add("hidden"));

$$("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$$("[data-prompt]").forEach((button) => button.addEventListener("click", () => { els.input.value = button.dataset.prompt; resizeComposer(); els.input.focus(); }));

els.conversations.addEventListener("click", (event) => {
  const button = event.target.closest("[data-conversation]"); if (button) openConversation(button.dataset.conversation);
});
els.projectGrid.addEventListener("click", async (event) => {
  const chat = event.target.closest("[data-project-chat]");
  const code = event.target.closest("[data-project-code]");
  const del = event.target.closest("[data-project-delete]");
  if (chat) { newChat(); els.projectSelect.value = chat.dataset.projectChat; updateContextLabel(); }
  if (code) { showView("code"); els.codeProjectSelect.value = code.dataset.projectCode; await loadCodeProject(code.dataset.projectCode); }
  if (del) { try { await deleteProject(del.dataset.projectDelete); } catch (error) { toast(error.message); } }
});
els.fileList.addEventListener("click", (event) => { const button = event.target.closest("[data-file]"); if (button) openFile(button.dataset.file); });
els.pluginList.addEventListener("click", async (event) => {
  const run = event.target.closest("[data-plugin-run]");
  const del = event.target.closest("[data-plugin-delete]");
  if (run) openPluginRunner(run.dataset.pluginRun);
  if (del && confirm("Delete this plugin manifest?")) {
    try { await api(`/api/plugins/${encodeURIComponent(del.dataset.pluginDelete)}`, { method: "DELETE" }); state.plugins = await api("/api/plugins"); renderPlugins(); toast("Plugin deleted"); } catch (error) { toast(error.message); }
  }
});

(async function boot() {
  renderChat();
  if (!state.token) return;
  try { await connect(state.token); } catch { sessionStorage.removeItem("hangpt_token"); state.token = ""; els.auth.classList.remove("hidden"); els.app.classList.add("hidden"); }
})();
