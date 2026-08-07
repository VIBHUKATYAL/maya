const { schedule } = require("@netlify/functions");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { tavily } = require("@tavily/core");

exports.handler = schedule("@hourly", async (event) => {
  console.log("Starting Autonomous Agent Loop...");

  // 0. Validate Environment Variables
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const tavilyApiKey = process.env.TAVILY_API_KEY;

  if (!supabaseUrl || !supabaseKey || !geminiApiKey || !tavilyApiKey) {
    console.error("Missing required environment variables.");
    return { statusCode: 500 };
  }

  // Initialize Clients
  const supabase = createClient(supabaseUrl, supabaseKey);
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const tvly = tavily({ apiKey: tavilyApiKey });

  // 1. Fetch Agents
  const { data: agents, error: agentsError } = await supabase
    .from("Agents")
    .select("*");

  if (agentsError) {
    console.error("Error fetching agents:", agentsError);
    return { statusCode: 500 };
  }

  if (!agents || agents.length === 0) {
    console.log("No active agents found.");
    return { statusCode: 200 };
  }

  // 2. Loop Through Each Agent
  for (const agent of agents) {
    console.log(`Processing Agent: ${agent.id}`);

    try {
      const persona = agent.persona || {};
      const domain = persona.domain || "Technology";

      // 3. Tavily Discovery Layer
      const searchResponse = await tvly.search(
        `Latest news and developments in ${domain}`,
        {
          searchDepth: "basic",
          includeAnswers: false,
          maxResults: 3,
        },
      );

      const newsContext = searchResponse.results
        .map((r) => `Title: ${r.title}\nContent: ${r.content}\nURL: ${r.url}`)
        .join("\n\n");

      // 4. Memory Retrieval (Fetch last 5 posts for this agent)
      let pastPostsData = [];
      const { data: posts1, error: posts1Error } = await supabase
        .from("Posts")
        .select("*")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false })
        .limit(5);

      if (posts1Error && posts1Error.code === "42703") {
        // 42703 undefined_column, attempt camelCase fallback
        const { data: posts2 } = await supabase
          .from("Posts")
          .select("*")
          .eq("agentId", agent.id)
          .order("created_at", { ascending: false })
          .limit(5);
        if (posts2) pastPostsData = posts2;
      } else if (posts1) {
        pastPostsData = posts1;
      }

      const memoryContext =
        pastPostsData.length > 0
          ? pastPostsData
              .map((p) => `Post Text: ${p.text}\nRationale: ${p.rationale}`)
              .join("\n\n")
          : "No past posts.";

      // 5. LLM Brain (Gemini 1.5)
      const prompt = `
### ROLE ###
You are an autonomous AI content creator and highly selective editor. Your persona parameters are:
- Name: ${persona.name || "AI Assistant"}
- Domain/Focus: ${domain}

### TASK ###
Review the following live news articles and decide whether to publish a post. You have rigorous editorial standards:
1. ONLY publish if an article is highly relevant to your Domain, insightful, and unique.
2. Otherwise, REJECT the topics and do not publish.

### MEMORY (DO NOT REPEAT THESE TOPICS) ###
${memoryContext}

### LIVE NEWS SOURCES ###
${newsContext}

### OUTPUT FORMAT ###
You MUST output valid, raw JSON exactly matching this structure. 
{
  "decision": "PUBLISH" | "REJECT",
  "text": "The actual post content written in your persona's voice (if PUBLISH).",
  "rationale": "Why you chose to publish or reject these topics.",
  "sources": ["URL1", "URL2"]
}
`;

      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        generationConfig: {
          responseMimeType: "application/json",
        },
      });

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      let llmOutput;

      try {
        llmOutput = JSON.parse(responseText.trim());
      } catch (e) {
        console.error(
          `Failed to parse LLM JSON for agent ${agent.id}`,
          e,
          responseText,
        );
        continue; // Skip onto next agent on failure
      }

      console.log(`Decision for Agent ${agent.id}: ${llmOutput.decision}`);

      // 6. DB Storage / Stateful Output
      if (llmOutput.decision === "PUBLISH") {
        // Base payload trying both key styles since schema structure isn't entirely known.
        // It's safest to insert minimal fields if specific columns fail.
        let postPayload = {
          agent_id: agent.id,
          text: llmOutput.text,
          rationale: llmOutput.rationale,
          sources: llmOutput.sources || [],
        };

        const { error: insertError } = await supabase
          .from("Posts")
          .insert([postPayload]);

        if (insertError) {
          console.log(
            "Primary insert failed, retrying with camelCase.",
            insertError,
          );
          await supabase.from("Posts").insert([
            {
              agentId: agent.id,
              text: llmOutput.text,
              rationale: llmOutput.rationale,
              sources: llmOutput.sources || [],
            },
          ]);
        }
      }
    } catch (agentLoopError) {
      console.error(`Error processing agent ${agent.id}:`, agentLoopError);
    }
  }

  console.log("Agent Loop Complete.");
  return { statusCode: 200 };
});
