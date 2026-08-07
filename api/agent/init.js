const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { tavily } = require("@tavily/core");

module.exports = async (req, res) => {
  // CORS Configuration
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { persona } = req.body || {};

    if (!persona || !persona.name || !persona.domain) {
      return res.status(400).json({
        error:
          'Bad Request: "persona" object with "name" and "domain" is required.',
      });
    }

    const { SUPABASE_URL, SUPABASE_KEY, TAVILY_API_KEY } = process.env;
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const tvly = tavily({ apiKey: TAVILY_API_KEY });

    // 1. Initialize Agent
    const { data: agentData, error: agentError } = await supabase
      .from("Agents")
      .insert([{ persona }])
      .select("id")
      .single();

    if (agentError) throw agentError;
    const agentId = agentData.id || agentData.agentId;

    // 2. 🔥 INSTANTLY GENERATE FIRST POST (Seed the feed)
    try {
      const searchResponse = await tvly.search(
        `Latest developments and breaking news regarding ${persona.domain}`,
        { searchDepth: "basic", maxResults: 3 },
      );
      const newsContext = searchResponse.results
        .map((r) => `Title: ${r.title}\nContent: ${r.content}\nURL: ${r.url}`)
        .join("\n\n");
      const prompt = `### ROLE ###\nYou are an autonomous AI content creator. Your persona:\n- Name: ${persona.name}\n- Domain/Focus: ${persona.domain}\n\n### TASK ###\nReview these live news articles and decide whether to publish a post. ONLY publish if highly relevant. REJECT generic topics.\n\n### LIVE NEWS SOURCES ###\n${newsContext}\n\n### OUTPUT FORMAT ###\nYou MUST output valid, raw JSON exactly matching this structure. \n{\n  "decision": "PUBLISH" | "REJECT",\n  "text": "The actual post content written in your persona's voice (if PUBLISH).",\n  "rationale": "Why you chose to publish or reject these topics.",\n  "sources": ["URL1", "URL2"]\n}`;

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
            model: "llama3-8b-8192",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
          }),
        },
      );
      const groqData = await groqFetch.json();
      if (groqData.error)
        throw new Error("Groq API failed: " + JSON.stringify(groqData.error));
      let rawText = groqData.choices[0].message.content.trim();

      if (rawText.startsWith("```json"))
        rawText = rawText.replace(/```json/g, "");
      if (rawText.startsWith("```")) rawText = rawText.replace(/```/g, "");
      if (rawText.endsWith("```")) rawText = rawText.slice(0, -3);

      const llmOutput = JSON.parse(rawText.trim());

      if (llmOutput.decision === "PUBLISH") {
        const { error: insertError } = await supabase.from("Posts").insert([
          {
            agent_id: agentId,
            text: llmOutput.text,
            rationale: llmOutput.rationale,
            sources: llmOutput.sources || [],
          },
        ]);
        if (insertError)
          await supabase.from("Posts").insert([
            {
              agentId,
              text: llmOutput.text,
              rationale: llmOutput.rationale,
              sources: llmOutput.sources || [],
            },
          ]);
      }
    } catch (e) {
      console.error("Failed to generate instant post:", e);
    }

    return res.status(200).json({ agentId });
  } catch (error) {
    console.error("Internal Server Error:", error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
};
