# HanGPT

HanGPT is a Cloudflare-native, ChatGPT-style personal AI workspace built on the OpenAI API.

It includes persistent chats, Projects, a Codex-style coding mode with a virtual project filesystem, a plugin/webhook registry, optional web search, model selection, and a Cloudflare Workers deployment path.

> HanGPT is an independent application. It does not copy or unlock a ChatGPT Plus subscription or proprietary OpenAI product entitlements; API usage is billed separately through the configured OpenAI API account.

## Stack

- Cloudflare Workers + Static Assets
- Cloudflare KV for projects, conversations, files, and plugin manifests
- OpenAI Responses API
- Vanilla HTML/CSS/JS frontend for a small deployment footprint

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars
# add OPENAI_API_KEY and APP_TOKEN
npm run dev
```

Open the local Wrangler URL, enter the same `APP_TOKEN`, and start chatting.

## Deploy to Cloudflare

1. Connect this GitHub repository to Cloudflare Workers Builds, or deploy from your terminal.
2. Add the Worker secrets `OPENAI_API_KEY` and `APP_TOKEN`.
3. Deploy with `npm run deploy`.

The `DATA` KV binding is declared without a namespace ID so current Wrangler/Workers automatic provisioning can create it during deployment. If your Cloudflare account or deployment path requires an explicit namespace, create one and add its `id` to `wrangler.jsonc`.

### GitHub Actions deployment

A workflow is included at `.github/workflows/deploy.yml`. Add these GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `OPENAI_API_KEY`
- `APP_TOKEN`

The workflow uploads the application secrets with Wrangler and deploys on pushes to `main`.

## Features

### Chat
- GPT-5.6 model family selection
- Reasoning effort control
- Optional OpenAI web search tool
- Conversation history stored in KV

### Projects
- Project-specific instructions
- Project-scoped conversations
- Virtual file workspace

### Code mode
- Read, write, list, and delete virtual project files through model function calls
- Automatic tool loop on the Worker
- File browser in the UI
- Useful for planning and generating code without exposing your Cloudflare/OpenAI secrets to the browser

### Plugins
- Register HTTPS webhook/API endpoints
- Invoke them from the Plugins panel
- Optional per-call JSON headers and payloads
- Plugin secrets are not stored in the manifest

## Security

`APP_TOKEN` protects the API for a personal deployment. For stronger access control, put the Worker behind Cloudflare Access as well. Keep `OPENAI_API_KEY` and other credentials in Worker secrets, never in frontend code or committed files.

## License

MIT
