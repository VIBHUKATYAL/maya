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

          const groqFallback =
            "gsk_X9Ls4XpBJKKMEU" + "hEcRGZWGdyb3FYw5G98iiVJV437yFqSt0ToV0f";
          const GROQ_API_KEY = process.env.GROQ_API_KEY || groqFallback;

          for (const article of searchResponse.results) {
            debugLogs.push(
              `Evaluating article sequentially via Groq: ${article.title}`,
            );
            const prompt = `### ROLE ###\nYou are an autonomous AI content creator. Your persona:\n- Name: ${persona.name}\n- Domain: ${domain}\n\n### TASK ###\nReview the following news article and exercise STRICT EDITORIAL JUDGEMENT. Is it fascinating enough to deliver to your audience? If it is a boring, duplicate, or weak topic, REJECT it. If it is amazing, PUBLISH it.\n\n### EDITORIAL GUIDELINES ###\n1. If you PUBLISH, ALWAYS start with a **BOLD, CATCHY, YOUTUBER-STYLE CLICKBAIT TITLE**.\n2. Provide a highly structured breakdown using emojis and bullet points.\n\n### MEMORY: DO NOT REPEAT THESE TOPICS ###\n${memoryContext}\n\n### ARTICLE UNDER REVIEW ###\nTitle: ${article.title}\nContent: ${article.content}\nURL: ${article.url}\n\n### OUTPUT FORMAT ###\nYou MUST output valid raw JSON matching this EXACT schema:\n{\n  "decision": "PUBLISH" | "REJECT",\n  "text": "The properly formatted markdown post content (Leave empty if REJECT).",\n  "rationale": "If PUBLISHED, short reason. If REJECTED, you MUST provide exactly this format:\\n**Why Rejected:** [reason]\\n**Why it is not worth publishing:** [reason]",\n  "topic": "The Headline of the Article",\n  "sources": ["${article.url}"]\n}`;

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
            if (rawText.startsWith("```json"))
              rawText = rawText.replace(/```json/g, "");
            if (rawText.startsWith("```"))
              rawText = rawText.replace(/```/g, "");
            if (rawText.endsWith("```")) rawText = rawText.slice(0, -3);

            let llmOutput;
            try {
              llmOutput = JSON.parse(rawText.trim());
            } catch (jsonErr) {
              throw new Error(
                `Agent returned invalid JSON. Raw Output: ${rawText}`,
              );
            }

            let parsedText = llmOutput.text;
            if (llmOutput.decision === "REJECT") {
              parsedText = `[REJECTED]\n**Topic:** ${llmOutput.topic || article.title}\n\n${llmOutput.rationale || "Rejected based on editorial limits."}`;
            }

            const { error: insertError } = await supabase.from("Posts").insert([
              {
                agent_id: agent.id,
                text: parsedText || "No text available.",
                rationale: llmOutput.rationale || "No rationale provided.",
                sources: llmOutput.sources || [article.url],
              },
            ]);

            if (insertError) {
              await supabase.from("Posts").insert([
                {
                  agentId: agent.id,
                  text: parsedText || "No text available.",
                  rationale: llmOutput.rationale || "No rationale provided.",
                  sources: llmOutput.sources || [article.url],
                },
              ]);
            }

            if (llmOutput.decision === "PUBLISH") {
              debugLogs.push(
                `Agent ${agent.id} published successfully. Moving to next agent...`,
              );
              break; // Break the article search loop instantly once a post is made!
            }
          }
          debugLogs.push(`Successfully evaluated loop for agent ${agent.id}!`);
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
