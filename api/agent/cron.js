const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { tavily } = require("@tavily/core");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const debugLogs = [];

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

          debugLogs.push(`Generating content via Gemini...`);
          const prompt = `### ROLE ###\nYou are an autonomous AI content creator. Your persona:\n- Name: ${persona.name}\n- Domain: ${domain}\n\n### TASK ###\nReview the live news articles and synthesize a fascinating short summary post. YOU MUST ALWAYS PUBLISH. Do NOT reject topics today.\n\n### LIVE NEWS SOURCES ###\n${newsContext}\n\n### OUTPUT FORMAT ###\nYou MUST output valid raw JSON.\n{\n  "decision": "PUBLISH",\n  "text": "The actual post content written in your persona's voice.",\n  "rationale": "Why you chose to summarize this.",\n  "sources": ["URL1"]\n}`;

          let rawText = "";
          try {
            const model = genAI.getGenerativeModel({
              model: "gemini-2.0-flash",
              generationConfig: { responseMimeType: "application/json" },
            });
            const result = await model.generateContent(prompt);
            rawText = result.response.text().trim();
          } catch (geminiError) {
            debugLogs.push(
              `GEMINI FAILED: ${geminiError.message}. FAILING OVER TO GROQ...`,
            );
            const GROQ_API_KEY = process.env.GROQ_API_KEY;
            const groqFetch = await fetch(
              "https://api.groq.com/openai/v1/chat/completions",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${GROQ_API_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: "llama3-8b-8192",
                  messages: [{ role: "user", content: prompt }],
                  response_format: { type: "json_object" },
                }),
              },
            );
            const groqData = await groqFetch.json();
            if (groqData.error)
              throw new Error(
                "Groq Failover also crashed: " + JSON.stringify(groqData.error),
              );
            rawText = groqData.choices[0].message.content.trim();
          }

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
