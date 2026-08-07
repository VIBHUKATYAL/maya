const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { tavily } = require("@tavily/core");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const { SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY, TAVILY_API_KEY } =
      process.env;
    if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_API_KEY || !TAVILY_API_KEY) {
      return res
        .status(500)
        .json({ error: "Missing required Vercel Environment Variables!" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const tvly = tavily({ apiKey: TAVILY_API_KEY });

    const { data: agents } = await supabase.from("Agents").select("*");
    if (!agents || agents.length === 0)
      return res.status(200).json({ status: "No active agents" });

    // PARALLEL EXECUTION: Fixes Vercel 10-second timeout throttling blocks!
    await Promise.allSettled(
      agents.map(async (agent) => {
        try {
          const persona = agent.persona || {};
          const domain = persona.domain || "Technology";

          const searchResponse = await tvly.search(
            `Latest news and developments in ${domain}`,
            { searchDepth: "basic", maxResults: 3 },
          );
          const newsContext = searchResponse.results
            .map(
              (r) => `Title: ${r.title}\nContent: ${r.content}\nURL: ${r.url}`,
            )
            .join("\n\n");

          let pastPostsData = [];
          const { data: posts1, error: posts1Error } = await supabase
            .from("Posts")
            .select("*")
            .eq("agent_id", agent.id)
            .order("created_at", { ascending: false })
            .limit(5);
          if (posts1Error && posts1Error.code === "42703") {
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
          const prompt = `### ROLE ###\nYou are an autonomous AI content creator. Your persona:\n- Name: ${persona.name}\n- Domain: ${domain}\n\n### TASK ###\nReview live news articles and decide whether to publish a post. ONLY publish if highly relevant. REJECT generic topics.\n\n### MEMORY (DO NOT REPEAT THESE TOPICS) ###\n${memoryContext}\n\n### LIVE NEWS SOURCES ###\n${newsContext}\n\n### OUTPUT FORMAT ###\nYou MUST output valid raw JSON.\n{\n  "decision": "PUBLISH" | "REJECT",\n  "text": "The actual post content written in your persona's voice (if PUBLISH).",\n  "rationale": "Why you chose to publish or reject these topics.",\n  "sources": ["URL1"]\n}`;

          const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            generationConfig: { responseMimeType: "application/json" },
          });
          const result = await model.generateContent(prompt);
          let llmOutput = JSON.parse(result.response.text().trim());

          if (llmOutput.decision === "PUBLISH") {
            const { error: insertError } = await supabase
              .from("Posts")
              .insert([
                {
                  agent_id: agent.id,
                  text: llmOutput.text,
                  rationale: llmOutput.rationale,
                  sources: llmOutput.sources || [],
                },
              ]);
            if (insertError)
              await supabase
                .from("Posts")
                .insert([
                  {
                    agentId: agent.id,
                    text: llmOutput.text,
                    rationale: llmOutput.rationale,
                    sources: llmOutput.sources || [],
                  },
                ]);
          }
        } catch (e) {
          console.error(`Error processing agent ${agent.id}:`, e);
        }
      }),
    );

    return res.status(200).json({ status: "Vercel Agent Loop Complete" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
