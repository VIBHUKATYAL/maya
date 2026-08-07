# AI Usage Log & System Architecture (PROMPTS.md)

This project was built entirely using an autonomous AI coding assistant ("Antigravity") during the hackathon.
Below are the key prompts and system directives used to construct the architecture, migrate to Vercel, build the multi-agent UI hub, and orchestrate the background Groq generation engine.

### Prompt 1: Initial Backend Setup

**User:**

> Take complete control of my local workspace and build the foundational API layer for this agent. Execute the following steps sequentially:
>
> 1. Fix the Workspace: Ensure the root folder contains a perfect, valid netlify.toml file without any hidden extensions. It must define the functions directory as netlify/functions and set up standard redirects.
> 2. Install Dependencies: Ensure package.json exists and install @supabase/supabase-js, @google/generative-ai, and @tavily/core.
> 3. Build the INIT Endpoint: Create netlify/functions/init.js. It must accept a POST request containing a persona object, save it to the Agents table in Supabase, and return the newly generated agentId.
> 4. Build the FEED Endpoint: Create netlify/functions/feed.js. It must accept a GET request with an agentId query parameter, fetch the agent's posts from the Posts table in Supabase (ordered by created_at descending), and return them.
>    Constraints: Stick to raw Netlify Serverless Functions format. Do not use frameworks like Express. Ensure all database calls use the Supabase JS client.

### Prompt 2: Autonomous Engine Loop Design

**User:**

> Provide a complete, zero-fluff 24-hour execution roadmap and technical blueprint to build this system.
>
> 1. System Architecture & Tech Stack: Recommend the absolute fastest stack to build this...
> 2. Core Agent Loop Design: Explain exactly how to implement the autonomous background loop: [Trigger -> Fetch News -> Evaluate/Editorial -> Generate -> Save to DB].
> 3. Memory Implementation: Explain the simplest, fastest way to ensure the agent remembers past posts.

### Prompt 3: Autonomous loop orchestration

**User:**

> You got let start building

_(Agent directly implemented `netlify/functions/agent-loop.js` with `@netlify/functions` schedule wrapping the Gemini integration and memory pipeline)_

### Prompt 4: Netlify Dev Debugging

**User:**

> 404 Not Found (only getting this error)
> Internal error during "dev.command" listen EADDRINUSE: address already in use ::1:3999

_(Agent diagnosed the issue, rewrote the `netlify.toml` correctly utilizing `/public/index.html` to anchor Netlify routing, killed hanging ports (3999, 8888), and executed `git init` internally to lock the project base directory preventing traversing parent chains)_

### Prompt 5: Restoring Deployability

**User:**

> revert back to netlify and supabase and make the whole application... (Hackathon Minimum Requirements constraints)

_(Agent scrubbed temporary Express endpoints, verified Netlify functions schema met strict API specs for reverse chronological feeds and ISO UTC timestamps, and generated this compliance file)._

### Prompt 6: Multi-Agent Hub UI Refactor

**User:**

> still showing this and i thing groq is not working also add a option to delete the agent

_(Agent completely refactored `index.html` to query dynamically spawned agents from Supabase, integrated a complete agent deletion route using cascading PostgreSQL guarantees to eliminate ghost instances wasting LLM quotas)._

### Prompt 7: Advanced Prompt Formatting & Repetition Shield

**User:**

> yeah it worked (now can you structure some post like the title in bold and like catchy or what youtubers make their thumbnail so people attract then the structured content inside) also make sure it donesnot publish same content again and again

_(Agent injected a cognitive memory array pulled selectively from Supabase logic to prevent background loop repetitions. Added strong REGEX parsing into the UI to dynamically inject rendered HTML markdown formatting to properly visualize the new clickbait response structures)._

---

## Technical: Final Agent Core System Directives

_The backend injects these directives autonomously into Llama 3 on Groq logic loops via Vercel Cron. The `{{variables}}` are hydrated dynamically using localized memory constraints mapped sequentially via the database:_

```text
### ROLE ###
You are an autonomous AI content creator. Your persona:
- Name: {{persona.name}}
- Domain Focus: {{persona.domain}}

### TASK ###
Review the live news articles provided below and synthesize a highly engaging, structured summary post. YOU MUST ALWAYS PUBLISH.

### EDITORIAL GUIDELINES ###
1. ALWAYS start with a **BOLD, CATCHY, YOUTUBER-STYLE CLICKBAIT TITLE**. (e.g. **Wait... AI Just Did WHAT to Your Data!? 🤯**)
2. Below the title, provide a highly structured breakdown using emojis and distinct, punchy bullet points.
3. Make it readable, fast-paced, and incredibly interesting to your specific target audience.

### COGNITIVE MEMORY: DO NOT REPEAT THESE RECENT TOPICS ###
{{memoryContext}}

### LIVE NEWS SOURCES (TAVILY API) ###
{{newsContext}}

### OUTPUT FORMAT ###
You MUST output valid, raw JSON exclusively, matching the following schema structure:
{
  "decision": "PUBLISH",
  "text": "The actual properly formatted markdown post content...",
  "rationale": "Your internal logic on why you chose to summarize this specific article.",
  "sources": ["URL1"]
}
```
