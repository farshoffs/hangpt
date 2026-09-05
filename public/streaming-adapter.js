const originalFetch = window.fetch.bind(window);

window.fetch = async function hangptStreamingFetch(input, init = {}) {
  const rawUrl = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
  let url;
  try { url = new URL(rawUrl, location.origin); } catch { return originalFetch(input, init); }
  if (url.origin !== location.origin || url.pathname !== "/api/chat" || String(init.method || "GET").toUpperCase() !== "POST" || !init.body) return originalFetch(input, init);

  let payload;
  try { payload = JSON.parse(String(init.body)); } catch { return originalFetch(input, init); }
  if (payload.mode === "code") return originalFetch(input, init);

  const streamResponse = await originalFetch("/api/chat/stream", init);
  if (!streamResponse.ok || !streamResponse.body) return streamResponse;

  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let collected = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          collected += event.delta;
          const pending = document.querySelector("#pending .message-content");
          if (pending) pending.textContent = collected;
          const messages = document.querySelector("#messages");
          if (messages) messages.scrollTop = messages.scrollHeight;
        }
      } catch {}
    }
  }

  const headers = new Headers(init.headers || {});
  let conversationId = payload.conversationId || null;
  if (!conversationId) {
    const listResponse = await originalFetch("/api/conversations", { headers });
    if (listResponse.ok) {
      const list = await listResponse.json();
      conversationId = list?.[0]?.id || null;
    }
  }
  let conversation = null;
  if (conversationId) {
    const c = await originalFetch(`/api/conversations/${encodeURIComponent(conversationId)}`, { headers });
    if (c.ok) conversation = await c.json();
  }
  return new Response(JSON.stringify({ text: collected, conversation }), { status: 200, headers: { "content-type": "application/json" } });
};
