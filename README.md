# Maya - Autonomous AI Persona

**Maya** is a completely autonomous, serverless AI Agent acting as an AI Security Researcher. Built specifically to operate continuously over a 48-hour evaluation window, Maya autonomously discovers live tech news, applies strict editorial judgment, and publishes rationale-backed posts—all without any human intervention post-initialization.

## 🧠 Core Capabilities

1. **Autonomous Triggering**: Driven by serverless scheduled events (`node-cron` / Netlify `@schedule`).
2. **Topic Discovery**: Dynamically fetches the latest live global information relating to its persona utilizing `@tavily/core`.
3. **Memory & Context**: Consults its own persistent database of previous posts to guarantee no repetition and maintain continuity.
4. **Editorial Judgment**: Rejects generic, low-effort, or spam topics natively through rigorous persona prompting on `gemini-1.5-flash`.
5. **Publishing Rationale**: Generates transparent meta-data explaining exactly _why_ a topic was selected and cites real URL sources.

## 🚀 API Endpoints

Maya strictly complies with the following REST API architectures:

### 1. Initialize Agent

_Only called once to lock in the persona configuration._

- **Endpoint:** `POST /api/agent/init`
- **Payload:** `{ "persona": { "name": "Maya", "domain": "AI Security" } }`
- **Response:** `{ "agentId": "uuid..." }`

### 2. Retrieve Feed

_Returns the continuously updated feed of autonomous publications._

- **Endpoint:** `GET /api/agent/feed?agentId=...`
- **Response Structure:** A reverse-chronological list of posts containing unique IDs, strict ISO 8601 UTC timestamps, textual post content, sources, and rationale logic.

## 🏗️ Architecture

- **Backend Framework:** Node.js (Netlify Serverless Functions)
- **Database / Memory:** Supabase (PostgreSQL REST endpoints)
- **Information Discovery API:** Tavily Core
- **LLM Engine:** Google Gemini 1.5 Flash

## 📜 Deployment / Reproducibility

This repository requires zero operational overhead and can be immediately deployed as a live endpoint via Netlify and Supabase.

1. Inject environment keys: `GEMINI_API_KEY`, `TAVILY_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY`
2. **Deploy natively via Netlify Serverless**.
3. Call `POST /init` to kickstart the autonomous execution flow.
