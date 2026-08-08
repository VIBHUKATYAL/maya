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
      const searchQueries = [
        `Latest breaking news and developments in ${persona.domain}`,
        `Untold stories, deep dives, and highly engaging evergreen topics regarding ${persona.domain}`,
      ];

      const groqFallback =
        "gsk_X9Ls4XpBJKKMEU" + "hEcRGZWGdyb3FYw5G98iiVJV437yFqSt0ToV0f";
      const GROQ_API_KEY = process.env.GROQ_API_KEY || groqFallback;

      let postPublished = false;

      for (const query of searchQueries) {
        if (postPublished) break;
        const searchResponse = await tvly.search(query, {
          searchDepth: "basic",
          maxResults: 3,
        });

        if (!searchResponse || !searchResponse.results) continue;

        for (const article of searchResponse.results) {
          const evalPrompt = `### ROLE ###\nYou are a senior AI editorial architect formatting data for ${persona.name}.\nYour job is STRICT EDITORIAL EVALUATION. \nDetermine if the following article is worth publishing for the sector: ${persona.domain}\n\n### EDITORIAL STANDARDS ###\n- Relevance: Does this matter right now?\n- Evidence Quality: Are there credible sources?\n- Novelty: Is this a duplicate?\n- Viral Potential: Is this extremely fascinating, controversial, or highly important? If it is a generic, boring corporate update, YOU MUST REJECT IT.\n- Continuity: Is this a powerful follow-up to a PREVIOUSLY PUBLISHED topic? (If yes, heavily favor publishing it as an update). NEVER publish something overlapping a PREVIOUSLY REJECTED topic unless there is massive new evidence.\n\n### ARTICLE TO EVALUATE ###\nTitle: ${article.title}\nContent: ${article.content}\nURL: ${article.url}\n\n### RECENT MEMORY (PUBLISHED & REJECTED) ###\nNo previous posts. (This is the first evaluation for this new agent).\n\n### OUTPUT FORMAT ###\nYou MUST output valid JSON exactly matching this schema:\n{\n  "decision": "PUBLISH" | "REJECT",\n  "score": 0-100,\n  "confidence": 0.0-1.0,\n  "reasoning": {\n    "relevance": "string",\n    "evidence_quality": "string",\n    "novelty": "string"\n  },\n  "why_selected": "string (null if rejected)",\n  "why_relevant_now": "string (null if rejected)",\n  "sources": [{"title": "article title", "url": "article url"}],\n  "rejection_reason": "string (null if published)",\n  "topic": "Extracted Headline"\n}`;

          const evalFetch = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: evalPrompt }],
                response_format: { type: "json_object" },
              }),
            },
          );
          const evalResp = await evalFetch.json();
          if (evalResp.error) throw new Error("Groq Eval API failed");

          let rawEval = evalResp.choices[0].message.content.trim();
          if (rawEval.startsWith("```json"))
            rawEval = rawEval.replace(/```json/g, "");
          if (rawEval.startsWith("```")) rawEval = rawEval.replace(/```/g, "");
          if (rawEval.endsWith("```")) rawEval = rawEval.slice(0, -3);

          let evalData;
          try {
            evalData = JSON.parse(rawEval.trim());
          } catch (err) {
            evalData = {
              decision: "REJECT",
              rejection_reason: "Malformed LLM evaluation response.",
            };
          }

          let finalDecision = evalData.decision || "REJECT";
          let validationRejection = "";

          if (finalDecision === "PUBLISH") {
            if (
              !evalData.sources ||
              !evalData.sources.some((s) => s.url === article.url)
            ) {
              finalDecision = "REJECT";
              validationRejection = "Fabricated URL/Source mismatch detected.";
            } else if (!evalData.why_relevant_now) {
              finalDecision = "REJECT";
              validationRejection = "Missing publishing rationale criteria.";
            } else if (evalData.score && evalData.score < 85) {
              finalDecision = "REJECT";
              validationRejection =
                "Topic scored too low (under 85) logically to securely publish.";
            }
          }

          if (finalDecision !== "PUBLISH") {
            const combinedReason =
              validationRejection ||
              evalData.rejection_reason ||
              "Rejected by strict editorial logic.";
            const parsedText = `[REJECTED]\n**Topic:** ${evalData.topic || article.title}\n\n**Why Rejected:**\n${combinedReason}`;

            const { error: insertError } = await supabase.from("Posts").insert([
              {
                agent_id: agentId,
                text: parsedText,
                rationale: `Rejected evaluation.`,
                sources: [article.url],
              },
            ]);
            if (insertError) {
              await supabase.from("Posts").insert([
                {
                  agentId,
                  text: parsedText,
                  rationale: `Rejected evaluation.`,
                  sources: [article.url],
                },
              ]);
            }
            continue;
          }

          const writePrompt = `### ROLE ###\nYou are an autonomous AI content creator for: ${persona.name}.\nYou have just received an approved editorial topic. Your ONLY job is to write the highly engaging, Youtuber-style Clickbait Post based on the Editor's exact rationale.\n\n### EDITOR'S RATIONALE ###\nTopic: ${evalData.topic || article.title}\nWhy it was selected: ${evalData.why_selected}\nRelevance: ${evalData.why_relevant_now}\n\n### ARTICLE CONTEXT ###\nTitle: ${article.title}\nContent: ${article.content}\nURL: ${article.url}\n\n### OUTPUT FORMAT ###\nOutput ONLY valid JSON:\n{\n  "text": "The beautifully structured markdown text utilizing emojis, bullet points, and a BOLD Clickbait Title."\n}`;

          const writeFetch = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: writePrompt }],
                response_format: { type: "json_object" },
              }),
            },
          );
          const writeResp = await writeFetch.json();
          if (writeResp.error) throw new Error("Groq Write API failed");

          let rawWrite = writeResp.choices[0].message.content.trim();
          if (rawWrite.startsWith("```json"))
            rawWrite = rawWrite.replace(/```json/g, "");
          if (rawWrite.startsWith("```"))
            rawWrite = rawWrite.replace(/```/g, "");
          if (rawWrite.endsWith("```")) rawWrite = rawWrite.slice(0, -3);

          let generatedText = article.title;
          try {
            const parsedWrite = JSON.parse(rawWrite.trim());
            generatedText =
              parsedWrite.text ||
              parsedWrite.post ||
              parsedWrite.content ||
              rawWrite;
          } catch (e) {
            generatedText = rawWrite;
          }

          const rationaleOutput = `**Why Selected:** ${evalData.why_selected}\n**Relevance:** ${evalData.why_relevant_now}`;

          const { error: insertError } = await supabase.from("Posts").insert([
            {
              agent_id: agentId,
              text: generatedText || "No text available.",
              rationale: rationaleOutput,
              sources: [article.url],
            },
          ]);

          if (insertError) {
            await supabase.from("Posts").insert([
              {
                agentId,
                text: generatedText || "No text available.",
                rationale: rationaleOutput,
                sources: [article.url],
              },
            ]);
          }

          postPublished = true;
          break;
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
