# AI Judge

AI Judge takes a YouTube video of a debate round and produces an AI-generated decision — including a flow sheet, reason for decision (RFD), speaker scores, and per-team feedback.

Currently built for **APDA** (American Parliamentary Debate Association) format.

## How it works

The pipeline runs automatically from a single YouTube URL:

1. **Transcript** — Fetches YouTube captions, normalizes timestamps, and segments the transcript into 6 APDA speeches (PMC, LOC, MG, MO, LOR, PMR) using gap-based chunking with APDA duration priors and LLM stance validation
2. **Flow Sheet** — A two-pass LLM pipeline extracts arguments per speech in debate shorthand (tags, links, mechanisms, internal links, weighing) and clusters them into clash points
3. **Judging** — A multi-step judging pipeline:
   - Weighing analysis (what matters most in the round)
   - Clash evaluation (who won each clash)
   - Devil's advocate (2-3 paths to victory for the losing side)
   - RFD (why the winner beats all devil's advocate positions)
   - Speaker scores & ranks (using the APDA speaker scale)
   - Per-team feedback (strengths, weaknesses, improvements)

## Tech stack

- **Frontend**: React + TypeScript + Vite
- **Backend**: Node.js + Express
- **LLM**: Ollama Cloud (configurable — any OpenAI-compatible API works)
- **Monorepo**: npm workspaces (`client/` + `server/`)

## Getting started

### Prerequisites

- Node.js 18+
- An LLM API key (Ollama Cloud, Groq, or any OpenAI-compatible provider)

### Setup

1. Clone the repo:
   ```
   git clone https://github.com/adityavram/ai-judge.git
   cd ai-judge
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Configure the server:
   ```
   cp server/.env.example server/.env
   ```
   Edit `server/.env` and set your API key:
   ```
   LLM_API_KEY=your-api-key-here
   LLM_BASE=https://ollama.com
   LLM_MODEL=gpt-oss:120b
   ```

4. Start the dev servers:
   ```
   npm run dev:server   # terminal 1 — Express on :3001
   npm run dev:client   # terminal 2 — Vite on :5173
   ```

5. Open http://localhost:5173 and paste a YouTube debate URL.

### Configuration

| Env var | Default | Description |
|---|---|---|
| `LLM_API_KEY` | — | Required. Your LLM provider API key |
| `LLM_BASE` | `https://ollama.com` | LLM API base URL |
| `LLM_MODEL` | `gpt-oss:120b` | Model name |
| `PORT` | `3001` | Server port |
| `DAILY_ROUND_LIMIT` | `5` | Max rounds per user per day |

### Switching LLM providers

The LLM client uses Ollama's native API format (`/api/chat`). To use a different provider, update `LLM_BASE`, `LLM_API_KEY`, and `LLM_MODEL` in `server/.env`.

## Security

- **Anonymous UUID tracking**: Each browser gets a UUID stored in `localStorage`, sent as `X-Client-Id` header
- **Rate limiting**: Per-user daily round limit (default 5, configurable via `DAILY_ROUND_LIMIT`)
- **Input validation**: URL length, topic length, segment/clash count limits on all endpoints
- **Error handling**: Graceful user-facing messages for token exhaustion, rate limits, timeouts, and provider errors

## Project structure

```
ai-judge/
├── client/                 # Vite + React frontend
│   └── src/
│       ├── api/client.ts    # API client with UUID tracking
│       ├── components/
│       │   ├── UrlInput.tsx
│       │   ├── ProgressPipeline.tsx
│       │   ├── Collapsible.tsx
│       │   ├── TranscriptView.tsx
│       │   ├── FlowView.tsx
│       │   └── JudgeView.tsx
│       └── App.tsx          # Auto-run pipeline orchestrator
├── server/                  # Express backend
│   └── src/
│       ├── index.ts         # Express app + route wiring
│       ├── llm.ts           # LLM client with retry, error classification
│       ├── rateLimit.ts     # Per-UUID rate limiting middleware
│       ├── diarization.ts   # Speech segmentation + LLM stance validation
│       ├── flow.ts          # Two-pass flow sheet generation
│       ├── judge.ts         # Multi-step judging pipeline
│       ├── types.ts         # Shared TypeScript types
│       └── routes/
│           ├── transcript.ts
│           ├── flow.ts
│           └── judge.ts
├── speaks-guide.md          # APDA speaker scale reference
└── package.json             # npm workspaces root
```

## License

MIT