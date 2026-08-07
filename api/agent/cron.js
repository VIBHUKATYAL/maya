const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { tavily } = require("@tavily/core");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const debugLogs = [];

  try {
    const { SUPABASE_URL, SUPABASE_KEY, TAVILY_API_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_KEY || !TAVILY_API_KEY) {
      return res
        .status(500)
        .json({ error: "Missing required Vercel Environment Variables!" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const tvly = tavily({ apiKey: TAVILY_API_KEY });

    const { data: agents, error: agentFetchError } = await supabase
      .from("Agents")
      .select("*");
    if (agentFetchError)
      throw new Error(
        "Failed to fetch agents: " + JSON.stringify(agentFetchError),
      );
    if (!agents || agents.length === 0)
      return res.status(200).json({ status: "No active agents", debugLogs });

    await Promise.allSettled(
      agents.map(async (agent) => {
        try {
          const persona = agent.persona || {};
          if (persona.isActive === false) return; // SKIP PAUSED AGENTS
          debugLogs.push(`Starting agent ${agent.id}`);
          const domain = persona.domain || "Technology";

          debugLogs.push(`Searching Tavily for ${domain}...`);
          const searchResponse = await tvly.search(
            `Latest news and developments in ${domain}`,
            { searchDepth: "basic", maxResults: 3 },
          );

          if (!searchResponse || !searchResponse.results) {
            throw new Error("Tavily returned no results array.");
          }

          const newsContext = searchResponse.results
            .map(
              (r) => `Title: ${r.title}\nContent: ${r.content}\nURL: ${r.url}`,
            )
            .join("\n\n");

          // Pull Memory to prevent repeating content!
          const { data: posts } = await supabase
            .from("Posts")
            .select("text")
            .eq("agent_id", agent.id)
            .order("created_at", { ascending: false })
            .limit(4);

          const memoryContext =
            posts && posts.length > 0
              ? posts.map((p) => `- ${p.text.substring(0, 50)}...`).join("\\n")
              : "No previous posts.";

          debugLogs.push(`Generating content via Groq...`);
          const prompt = `### ROLE ###\nYou are an autonomous AI content creator. Your persona:\n- Name: ${persona.name}\n- Domain: ${domain}\n\n### TASK ###\nReview the live news articles and synthesize a highly engaging structured summary post. YOU MUST ALWAYS PUBLISH. \n\n### EDITORIAL GUIDELINES ###\n1. ALWAYS start with a **BOLD, CATCHY, YOUTUBER-STYLE CLICKBAIT TITLE**. (e.g. **Wait... AI Just Did WHAT to Your Data!? 🤯**)\n2. Below the title, provide a highly structured breakdown using emojis and distinct bullet points.\n3. Make it readable, punchy, and incredibly interesting.\n\n### MEMORY: DO NOT REPEAT THESE RECENT TOPICS ###\n${memoryContext}\n\n### LIVE NEWS SOURCES ###\n${newsContext}\n\n### OUTPUT FORMAT ###\nYou MUST output valid raw JSON.\n{\n  "decision": "PUBLISH",\n  "text": "The actual properly formatted markdown post content...",\n  "rationale": "Why you chose to summarize this.",\n  "sources": ["URL1"]\n}`;

          const groqFallback =
            "gsk_X9Ls4XpBJKKMEU" + "hEcRGZWGdyb3FYw5G98iiVJV437yFqSt0ToV0f";
          const GROQ_API_KEY = process.env.GROQ_API_KEY || groqFallback;

          const groqFetch = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" },
              }),
            },
          );
          const groqData = await groqFetch.json();
          if (groqData.error)
            throw new Error(
              "Groq API failed: " + JSON.stringify(groqData.error),
            );
          let rawText = groqData.choices[0].message.content.trim();

          // CRITICAL STRIPPING (Gemini loves to output backticks even in JSON mode)
          if (rawText.startsWith("```json"))
            rawText = rawText.replace(/```json/g, "");
          if (rawText.startsWith("```")) rawText = rawText.replace(/```/g, "");
          if (rawText.endsWith("```")) rawText = rawText.slice(0, -3);

          let llmOutput;
          try {
            llmOutput = JSON.parse(rawText.trim());
          } catch (jsonErr) {
            throw new Error("Gemini returned invalid JSON: " + rawText);
          }

          debugLogs.push(`Saving post to Supabase...`);
          const { error: insertError } = await supabase.from("Posts").insert([
            {
              agent_id: agent.id,
              text: llmOutput.text || "Default Post",
              rationale: llmOutput.rationale || "Forced",
              sources: llmOutput.sources || [],
            },
          ]);

          if (insertError) {
            debugLogs.push(
              `First insert failed, attempting fallback column naming (agentId)... ERR: ` +
                JSON.stringify(insertError),
            );
            const { error: fallbackErr } = await supabase.from("Posts").insert([
              {
                agentId: agent.id,
                text: llmOutput.text || "Default",
                rationale: llmOutput.rationale || "Forced",
                sources: llmOutput.sources || [],
              },
            ]);
            if (fallbackErr)
              throw new Error(
                "Fallback insert also failed: " + JSON.stringify(fallbackErr),
              );
          }
          debugLogs.push(`Successfully saved post for agent ${agent.id}!`);
        } catch (e) {
          const errString = e.message || JSON.stringify(e);
          console.error(`Error processing agent ${agent.id}:`, errString);
          debugLogs.push(`FAILED agent ${agent.id} -> ${errString}`);
        }
      }),
    );

    return res
      .status(200)
      .json({ status: "Vercel Agent Loop Complete", logs: debugLogs });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
