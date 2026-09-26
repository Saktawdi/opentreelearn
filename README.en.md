<div align="center">
  <h1>OpenTreeLearn</h1>
  <p><strong>A tree-structured learning workspace where conversation IS the content</strong></p>
  <p><a href="README.md">简体中文</a> · English</p>
  <img src="docs/screenshots/canvas-full.png" alt="The OpenTreeLearn learning-tree canvas" width="860" />
</div>

## Introduction

Real learning isn't finishing an article — it's growing a tree. OpenTreeLearn turns studying a topic into a **revisitable, forkable, traceable** tree of knowledge:

- **Every node is a conversation thread** — nodes have no separate body text; chatting IS how content is produced. Titles, summaries and mastery scores are distilled automatically by AI.
- **The tree is the path** — fork a new question from any message inside a node and a new branch appears on the canvas. The path of "how you learned it step by step" is preserved in full.
- **Agent as a collaborator** — the Agent can read the whole tree: retrieval on demand, remembers your mistakes and annotations, proactively plans reviews, and — with your authorization — tidies the tree directly (proposes, executes step by step, undoable at any time).
- **Remembering, on schedule** — built-in FSRS spaced repetition; the Review Center schedules every card's next visit based on your memory state.

Local-first: your data lives in your own browser (IndexedDB) and never leaves your machine. We don't provide model services — configure your own BYOK providers on the Settings page.

## Core Concepts

| Concept | Meaning |
| --- | --- |
| **Project** | One learning topic, with tags, your background, and default model settings |
| **Node** | A conversation thread — the content itself; a card on the canvas with mastery & review state |
| **Fork** | A child node split from any message, inheriting context and recording its origin |
| **Agent** | A collaborator that senses the whole tree and performs reversible, authorized operations |
| **Review Center** | One per project; FSRS-based spaced repetition |

## Features

- 🌳 **Learning-tree canvas** — node cards + orthogonal edges, drag to tidy, auto layout, memory heat map
- 💬 **Conversation as content** — Markdown / code highlighting (Shiki) / math (KaTeX); quote blocks can be tagged as mistakes or open questions
- 🌿 **Fork anywhere** — grow a new branch from any message; context is inherited automatically
- 🤖 **Agent loop** — native function calling; read-only tools always on, write tools off by default, explicitly opt-in and strictly reversible
- 🔁 **FSRS review** — spaced repetition + subtree mastery aggregation; weak points feed future review material
- 🔒 **Local-first** — IndexedDB, works offline; optional cross-device sync (self-hosted)
- 🔑 **BYOK, multi-provider** — OpenAI / Anthropic / Google / any OpenAI-compatible endpoint (LM Studio, Ollama, new-api, …)
- 🌐 **Bilingual UI** — zh-CN (primary) / English, switchable in Settings

## Getting Started

> Requires Node.js ≥ 20.19 (or ≥ 22.12) and pnpm

```bash
pnpm install
pnpm dev            # web app at http://localhost:6174
```

Then: **create a project → add your own API key in Settings → start your first conversation**.
API keys are stored only in your browser (IndexedDB / localStorage).

Optional (sync service for local development):

```bash
pnpm dev:all        # web app + NestJS sync service (:3901)
```

## Docker

```bash
cp .env.docker.example .env   # optional: override ports, etc.
docker compose up -d --build  # web (nginx) + api (sync service + SQLite)
# open http://localhost:8080
```

In production the frontend is a static site (nginx reverse-proxies `/lern-api` on the same origin); sync data lives in an SQLite volume.

## Cross-device Sync (optional)

The app is local-first: **without sync enabled, your data never leaves your device.**

When sync is enabled, learning data is stored in **your own self-hosted sync service** (`server/`, NestJS + SQLite, incremental pull/push) — under Docker it lives in your own SQLite volume and is **never uploaded to any server run by the author**.

The only piece that touches an author-run instance is **sign-in**: the built-in login talks to the account service hardcoded in `src/services/account/client.ts` (`https://api.sakta.top`). It merely issues and verifies identity tokens — it stores **no learning data**. To self-host identity as well, point that constant to your own account service and rebuild.

## Development

```bash
pnpm build        # type-check + build the web app
pnpm lint         # ESLint
pnpm test         # Vitest
pnpm typecheck    # tsc --noEmit
```

Stack: React 19 · Vite · Tailwind CSS v4 · Radix UI / shadcn-style components · @xyflow/react (canvas) · Dexie (IndexedDB) · ts-fsrs · AI SDK · NestJS + Prisma + SQLite (sync service)

## License

Released under the [MIT](LICENSE) License.
