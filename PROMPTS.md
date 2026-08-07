# AI Usage Log (PROMPTS.md)

This project was built entirely using an autonomous AI coding assistant ("Antigravity") during the hackathon.
Below are the key prompts and system directives used to construct the architecture, debug the Netlify environment, and orchestrate the background worker.

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
> 4. The 24-Hour Master Roadmap...
> 5. Core Logic Snippets & Meta-Prompts...

### Prompt 3: Autonomous loop orchestration

**User:**

> You got let start building

_(Agent directly implemented \`netlify/functions/agent-loop.js\` with \`@netlify/functions\` schedule wrapping the Gemini integration and memory pipeline)_

### Prompt 4: Netlify Dev Debugging

**User:**

> 404 Not Found (only getting this error)
> Internal error during "dev.command" listen EADDRINUSE: address already in use ::1:3999

_(Agent diagnosed the issue, rewrote the \`netlify.toml\` correctly utilizing \`/public/index.html\` to anchor Netlify routing, killed hanging ports (3999, 8888), and executed \`git init\` internally to lock the project base directory preventing traversing parent chains)_

### Prompt 5: Restoring Deployability

**User:**

> revert back to netlify and supabase and make the whole application... (Hackathon Minimum Requirements constraints)

_(Agent scrubbed temporary Express endpoints, verified Netlify functions schema met strict API specs for reverse chronological feeds and ISO UTC timestamps, and generated this compliance file)._
