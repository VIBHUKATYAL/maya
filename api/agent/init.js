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
      const groqFallback =
        "gsk_X9Ls4XpBJKKMEU" + "hEcRGZWGdyb3FYw5G98iiVJV437yFqSt0ToV0f";
      const GROQ_API_KEY = process.env.GROQ_API_KEY || groqFallback;

      for (const article of searchResponse.results) {
        const prompt = `### ROLE ###\nYou are an autonomous AI content creator. Your persona:\n- Name: ${persona.name}\n- Domain/Focus: ${persona.domain}\n\n### TASK ###\nReview the following news article and exercise STRICT EDITORIAL JUDGEMENT. Is it fascinating enough to deliver to your audience? If it is a boring, duplicate, or weak topic, REJECT it. If it is amazing, PUBLISH it.\n\n### EDITORIAL GUIDELINES ###\n1. If you PUBLISH, ALWAYS start with a **BOLD, CATCHY, YOUTUBER-STYLE CLICKBAIT TITLE** surrounded in double asterisks.\n2. Provide a highly structured breakdown using emojis and distinct bullet points.\n\n### ARTICLE UNDER REVIEW ###\nTitle: ${article.title}\nContent: ${article.content}\nURL: ${article.url}\n\n### OUTPUT FORMAT ###\nYou MUST output valid raw JSON matching this EXACT schema:\n{\n  "decision": "PUBLISH" | "REJECT",\n  "text": "The properly formatted markdown post content (Leave empty if REJECT).",\n  "rationale": "If PUBLISHED, short reason. If REJECTED, you MUST provide exactly this format:\\n**Why Rejected:** [reason]\\n**Why it is not worth publishing:** [reason]",\n  "topic": "The Headline of the Article",\n  "sources": ["${article.url}"]\n}`;

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
          throw new Error("Groq API failed: " + JSON.stringify(groqData.error));

        let rawText = groqData.choices[0].message.content.trim();
        if (rawText.startsWith("```json"))
          rawText = rawText.replace(/```json/g, "");
        if (rawText.startsWith("```")) rawText = rawText.replace(/```/g, "");
        if (rawText.endsWith("```")) rawText = rawText.slice(0, -3);

        const llmOutput = JSON.parse(rawText.trim());

        let parsedText = llmOutput.text;
        if (llmOutput.decision === "REJECT") {
          parsedText = `[REJECTED]\n**Topic:** ${llmOutput.topic || article.title}\n\n${llmOutput.rationale || "Rejected based on editorial limits."}`;
        }

        const { error: insertError } = await supabase.from("Posts").insert([
          {
            agent_id: agentId,
            text: parsedText || "No text generated.",
            rationale: llmOutput.rationale,
            sources: llmOutput.sources || [article.url],
          },
        ]);
        if (insertError) {
          await supabase.from("Posts").insert([
            {
              agentId,
              text: parsedText || "No text generated.",
              rationale: llmOutput.rationale,
              sources: llmOutput.sources || [article.url],
            },
          ]);
        }

        if (llmOutput.decision === "PUBLISH") {
          break; // Stop immediately after the first successful publish setup!
        }
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
