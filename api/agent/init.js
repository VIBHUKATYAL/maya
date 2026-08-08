const { createClient } = require("@supabase/supabase-js");
const { tavily } = require("@tavily/core");
const {
  getStylePrompt,
  fetchWithGroqFallback,
} = require("../../lib/prompts.js");

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

    const { SUPABASE_URL, SUPABASE_KEY } = process.env;
    const tvlyKeys = (process.env.TAVILY_API_KEY || "tvly-kX03O8N")
      .split(",")
      .map((k) => k.trim());
    const TAVILY_API_KEY =
      tvlyKeys[Math.floor(Math.random() * tvlyKeys.length)];

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
      const rawDomain = persona.domain || "Technology";
      const domainList = rawDomain
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
      const domain =
        domainList[Math.floor(Math.random() * domainList.length)] ||
        "Technology";

      const allQueries = [
        `Latest breaking research, vulnerabilities, and technical developments in ${domain}`,
        `Distinct editorial opinions, deep dives, and expert analysis regarding ${domain}`,
        `Controversial debates, ethical concerns, and regulatory shifts in ${domain}`,
        `Future predictions, architectural changes, and scaling trends in ${domain}`,
        `Open-source contributions, developer tools, and practical implementations of ${domain}`,
        `Real-world case studies, product analytics, and startup innovations in ${domain}`,
        `Adversarial attacks, safety frameworks, and security research in ${domain}`,
        `Behind the scenes engineering challenges and executive strategy in ${domain}`,
      ];
      // Shuffle and pick 2 randomly
      const searchQueries = allQueries
        .sort(() => 0.5 - Math.random())
        .slice(0, 2);

      const groqFallback =
        "gsk_X9Ls4XpBJKKMEU" + "hEcRGZWGdyb3FYw5G98iiVJV437yFqSt0ToV0f";
      const groqKeys = (process.env.GROQ_API_KEY || groqFallback)
        .split(",")
        .map((k) => k.trim());
      const getGroqKey = () =>
        groqKeys[Math.floor(Math.random() * groqKeys.length)];

      let postPublished = false;

      for (const query of searchQueries) {
        if (postPublished) break;
        const searchResponse = await tvly.search(query, {
          searchDepth: "basic",
          topic: "news",
          maxResults: 10,
        });

        if (!searchResponse || !searchResponse.results) continue;

        for (const article of searchResponse.results) {
          const safeEvalContent = (article.content || "")
            .substring(0, 1500)
            .concat("...");

          const evalPrompt = `### ROLE ###\nYou are a senior AI editorial architect formatting data for ${persona.name}.\nYour job is STRICT EDITORIAL EVALUATION. \nDetermine if the following article is worth publishing for the sector: ${persona.domain}\n\n### EDITORIAL STANDARDS ###\n- Relevance: Does this matter right now?\n- Evidence Quality: Is the scraped domain a major, highly-credible journalistic or research institution? Automatically REJECT random forum posts, shady blog-spam, or unverified domains.\n- Novelty: Is this a duplicate?\n- Continuity: Is this a powerful follow-up to a PREVIOUSLY PUBLISHED topic? (If yes, heavily favor publishing it as an update). NEVER publish something overlapping a PREVIOUSLY REJECTED topic unless there is massive new evidence.\n\n### ARTICLE TO EVALUATE ###\nTitle: ${article.title}\nContent: ${safeEvalContent}\nURL: ${article.url}\n\n### RECENT MEMORY (PUBLISHED & REJECTED) ###\nNo previous posts. (This is the first evaluation for this new agent).\n\n### OUTPUT FORMAT ###\nYou MUST output valid JSON exactly matching this schema:\n{\n  "decision": "PUBLISH" | "REJECT",\n  "score": 0-100,\n  "confidence": 0.0-1.0,\n  "reasoning": {\n    "relevance": "string",\n    "evidence_quality": "string",\n    "novelty": "string"\n  },\n  "why_selected": "string (null if rejected)",\n  "why_relevant_now": "string (null if rejected)",\n  "sources": [{"title": "article title", "url": "article url"}],\n  "rejection_reason": "string (null if published)",\n  "topic": "Extracted Headline"\n}`;

          // THROTTLE TO PREVENT GROQ 429 RATE LIMITS (Max 30 requests/min free tier)
          await new Promise((resolve) => setTimeout(resolve, 900));

          const evalResp = await fetchWithGroqFallback(evalPrompt, groqKeys);

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
            } else if (evalData.score && evalData.score < 70) {
              finalDecision = "REJECT";
              validationRejection =
                "Topic scored too low logically to securely publish.";
            }
          }

          if (finalDecision !== "PUBLISH") {
            const combinedReason =
              validationRejection ||
              evalData.rejection_reason ||
              "Rejected by strict editorial logic.";
            const parsedText = `[REJECTED]\n**Topic:** ${evalData.topic || article.title}\n\n**Why Rejected:** ${combinedReason}`;

            const { error: insertError } = await supabase.from("Posts").insert([
              {
                agent_id: agentId,
                text: parsedText,
                rationale: combinedReason,
                sources: [article.url],
              },
            ]);
            if (insertError) {
              await supabase.from("Posts").insert([
                {
                  agentId,
                  text: parsedText,
                  rationale: combinedReason,
                  sources: [article.url],
                },
              ]);
            }
            continue;
          }

          const styleRules = getStylePrompt(
            persona.style || persona.writingStyle || "Tech Storytelling",
          );

          const safeWriteContent = (article.content || "")
            .substring(0, 2500)
            .concat("...");

          const writePrompt = `### ROLE ###\nYou are ${persona.name}, a highly opinionated expert in ${domain}.\nMaintain stable interests, a coherent voice, and distinct editorial opinions relevant to your domain.\nYou have just received an approved editorial topic. Your ONLY job is to write the post based on the Editor's exact rationale, STRICTLY following the Writing Style Rules below.\n\n### EDITOR'S RATIONALE ###\nTopic: ${evalData.topic || article.title}\nWhy it was selected: ${evalData.why_selected}\nRelevance: ${evalData.why_relevant_now}\n\n### ARTICLE CONTEXT ###\nTitle: ${article.title}\nContent: ${safeWriteContent}\nURL: ${article.url}\n\n${styleRules}\n\n### OUTPUT FORMAT ###\nOutput ONLY valid JSON:\n{\n  "text": "The final structured markdown text following the provided writing style perfectly, without any forced emojis."\n}`;

          // THROTTLE BEFORE GENERATION CALL TO PROTECT RATE LIMIT
          await new Promise((resolve) => setTimeout(resolve, 900));

          const writeResp = await fetchWithGroqFallback(writePrompt, groqKeys);

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
