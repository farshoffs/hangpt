# HanGPT

HanGPT is a Cloudflare-native personal AI workspace built on the OpenAI API. It combines ChatGPT-style conversations, Projects, coding agents, durable memory, custom agents, media tools, file uploads, external plugins, and optional GitHub-backed repository editing/execution.

> HanGPT is independent software. It does not unlock ChatGPT Plus product entitlements. OpenAI API usage is billed separately through your API account.

## Live architecture

- Cloudflare Workers + Static Assets
- KV as the zero-config persistence baseline
- Optional D1 mirror for structured records
- Optional R2 storage for uploaded blobs
- OpenAI Responses API, GPT-5.6 family, GPT-Image-2, speech and transcription APIs
- GitHub REST + Actions integration when a GitHub token is configured
- Vanilla HTML/CSS/JS UI with a dedicated Advanced workspace

## Features

### Chat
- GPT-5.6 / Sol / Terra / Luna selection
- reasoning effort through Max
- optional OpenAI web search
- progressive streaming in the main chat UI
- persistent conversation history
- project instructions, project defaults, agents and memories automatically injected

### Projects
- persistent project instructions
- project-scoped virtual files
- default model/reasoning/web-search policy
- default custom agent
- project memory toggle
- linked GitHub repository + branch
- encrypted project secrets when `MASTER_KEY` is configured

### Code / Codex-style workflow
- model tools for listing, reading, writing and deleting virtual project files
- linked GitHub file read/write tools
- real GitHub commits from Code mode when `GITHUB_TOKEN` is configured
- controlled GitHub Actions execution adapter
- execution is intentionally allow-listed to `typecheck`, `test`, `build`, and `lint`; the Worker is not an unrestricted remote shell

### Memory & Agents
- global and project-scoped durable memory
- reusable custom agents with model, reasoning, instructions and tool policy
- project default agent support

### Files & media
- file uploads up to 5 MB
- optional R2 storage adapter
- upload files to OpenAI Files
- GPT-Image-2 image generation
- GPT-4o Mini TTS speech generation
- GPT-Transcribe audio transcription

### Plugins
- HTTPS webhook/API manifests
- one-off request headers
- encrypted stored bearer/header secrets
- generic OAuth2 authorization-code flow:
  - OAuth configuration
  - encrypted client-secret storage
  - state-protected callback
  - access-token vault
  - automatic bearer injection on plugin calls

### Authentication & security
- `APP_TOKEN` required for private API access
- constant-time token comparison
- optional Cloudflare Access header enforcement
- AES-GCM encrypted project/plugin/OAuth secrets using `MASTER_KEY`
- plugin endpoint HTTPS and localhost restrictions
- GitHub execution is task allow-listed

## UI

Main workspace:

`/`

Advanced workspace:

`/advanced.html`

The Advanced workspace manages Memory, Agents, uploads/media, GitHub project settings, encrypted project secrets, and execution dispatch.

## Required GitHub repository secrets

The existing deployment requires:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `OPENAI_API_KEY`
- `APP_TOKEN`

Optional advanced features:

- `MASTER_KEY` — long random value used to encrypt project secrets, plugin credentials and OAuth tokens. The deployment workflow uploads it to the Worker secret `MASTER_KEY`.
- `HANGPT_GITHUB_TOKEN` — GitHub fine-grained/classic token used by HanGPT for linked repository reads/writes and workflow dispatch. The workflow uploads it to Worker secret `GITHUB_TOKEN`.

Never commit any of these values.

## GitHub token permissions

For linked repositories, give the HanGPT token access only to repositories you want HanGPT to operate on. For the full integration it needs repository Contents read/write and Actions/Workflows permissions sufficient to dispatch `hangpt-exec.yml`.

A safe execution workflow is included in this repository at `.github/workflows/hangpt-exec.yml`. Copy the same workflow into other linked repositories where you want HanGPT to execute allow-listed CI tasks.

## Cloudflare Access

HanGPT can require Cloudflare Access in addition to `APP_TOKEN`.

1. Put the Worker/custom domain behind a Cloudflare Access application.
2. Set Worker variable `CF_ACCESS_REQUIRED=true`.
3. HanGPT then requires Cloudflare's authenticated-user header as well as the app token.

`CF_ACCESS_EMAIL_HEADER` can override the default `cf-access-authenticated-user-email` header name.

## Optional D1 storage

KV remains active for compatibility. HanGPT can mirror structured records into an optional D1 binding named `DB`.

1. Create a D1 database.
2. Apply `migrations/0001.sql`.
3. Add a D1 binding named `DB` to `wrangler.jsonc` / Cloudflare Worker settings.

If the binding or table is absent, HanGPT automatically continues using KV.

## Optional R2 uploads

For larger/more durable uploaded-file storage, bind an R2 bucket as `FILES`. If `FILES` is not bound, upload bytes remain in KV.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Minimum `.dev.vars`:

```env
OPENAI_API_KEY=...
APP_TOKEN=...
OPENAI_MODEL=gpt-5.6
```

Optional:

```env
MASTER_KEY=...
GITHUB_TOKEN=...
CF_ACCESS_REQUIRED=false
```

## API highlights

- `POST /api/chat` — normal chat / code agent
- `POST /api/chat/stream` — SSE streaming chat
- `/api/memories` — memory CRUD
- `/api/agents` — agent CRUD
- `/api/uploads` — upload management
- `/api/media/image` — image generation
- `/api/media/speech` — text to speech
- `/api/media/transcribe` — transcription
- `/api/projects/:id/settings` — project defaults + GitHub link
- `/api/projects/:id/secrets` — encrypted secret vault
- `/api/projects/:id/github/*` — linked repo operations
- `POST /api/projects/:id/execute` — controlled GitHub Actions dispatch
- `/api/plugins/:id/oauth/*` — OAuth2 setup/connect flow

## Deployment

Pushes to `main` run typechecking and deploy through `.github/workflows/deploy.yml`. Required and optional Worker secrets are uploaded automatically when the matching GitHub repository secrets exist.

## License

MIT
