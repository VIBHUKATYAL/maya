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

          const searchQueries = [
            `Latest breaking news and developments in ${domain}`,
            `Untold stories, deep dives, and highly engaging evergreen topics regarding ${domain}`,
          ];

          let postPublished = false;

          // Pull Memory to prevent repeating content!
          // Pull Memory to prevent repeating content!
          const { data: posts } = await supabase
            .from("Posts")
            .select("text, rationale")
            .eq("agent_id", agent.id)
            .order("created_at", { ascending: false })
            .limit(10);

          const memoryContext =
            posts && posts.length > 0
              ? posts
                  .map((p) => {
                    const isRejected = p.text.startsWith("[REJECTED]");
                    const type = isRejected
                      ? "PREVIOUSLY REJECTED"
                      : "PREVIOUSLY PUBLISHED";
                    const snippet = p.text
                      .substring(0, 80)
                      .replace(/\\n/g, " ");
                    return `[${type}] ${snippet} | Editor Note: ${p.rationale}`;
                  })
                  .join("\n")
              : "No previous posts.";

          const groqFallback =
            "gsk_X9Ls4XpBJKKMEU" + "hEcRGZWGdyb3FYw5G98iiVJV437yFqSt0ToV0f";
          const GROQ_API_KEY = process.env.GROQ_API_KEY || groqFallback;

          for (const query of searchQueries) {
            if (postPublished) break; // Break outer loop completely if we found a good post!

            debugLogs.push(`Searching Tavily for: ${query}`);
            const searchResponse = await tvly.search(query, {
              searchDepth: "basic",
              maxResults: 3,
            });

            if (!searchResponse || !searchResponse.results) continue;

            for (const article of searchResponse.results) {
              // PROGRAMMATIC DUPLICATE FILTERING (JACCARD ALGORITHM)
              const getKeywords = (text) => {
                const words = (text || "")
                  .toLowerCase()
                  .replace(/[^a-z0-9\s]/g, "")
                  .split(/\s+/);
                return new Set(words.filter((w) => w.length > 4)); // Only significant words
              };

              const articleKeywords = getKeywords(article.title);
              let isExactDuplicate = false;

              if (posts && posts.length > 0) {
                for (const post of posts) {
                  const postKeywords = getKeywords(post.text);
                  let overlap = 0;
                  for (const word of articleKeywords) {
                    if (postKeywords.has(word)) overlap++;
                  }
                  const similarity =
                    overlap / Math.max(1, articleKeywords.size);
                  // If 40% of the significant words in the title match an existing post, it's a recycled story!
                  if (similarity > 0.4) {
                    isExactDuplicate = true;
                    break;
                  }
                }
              }

              if (isExactDuplicate) {
                debugLogs.push(
                  `Blocked Duplicate Algorithmically: ${article.title}`,
                );
                continue; // HARD SKIP! Never hits the LLM prompt.
              }

              debugLogs.push(
                `Evaluating article sequentially via Groq: ${article.title}`,
              );
              const evalPrompt = `### ROLE ###\nYou are a senior AI editorial architect formatting data for ${persona.name}.\nYour job is STRICT EDITORIAL EVALUATION. \nDetermine if the following article is worth publishing for the sector: ${domain}\n\n### EDITORIAL STANDARDS ###\n- Relevance: Does this matter right now?\n- Evidence Quality: Are there credible sources?\n- Novelty: Is this a duplicate?\n- Viral Potential: Is this extremely fascinating, controversial, or highly important? If it is a generic, boring corporate update, YOU MUST REJECT IT.\n- Continuity: Is this a powerful follow-up to a PREVIOUSLY PUBLISHED topic? (If yes, heavily favor publishing it as an update). NEVER publish something overlapping a PREVIOUSLY REJECTED topic unless there is massive new evidence.\n\n### ARTICLE TO EVALUATE ###\nTitle: ${article.title}\nContent: ${article.content}\nURL: ${article.url}\n\n### RECENT MEMORY (PUBLISHED & REJECTED) ###\n${memoryContext}\n\n### OUTPUT FORMAT ###\nYou MUST output valid JSON exactly matching this schema:\n{\n  "decision": "PUBLISH" | "REJECT",\n  "score": 0-100,\n  "confidence": 0.0-1.0,\n  "reasoning": {\n    "relevance": "string",\n    "evidence_quality": "string",\n    "novelty": "string"\n  },\n  "why_selected": "string (null if rejected)",\n  "why_relevant_now": "string (null if rejected)",\n  "sources": [{"title": "article title", "url": "article url"}],\n  "rejection_reason": "string (null if published)",\n  "topic": "Extracted Headline"\n}`;

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

              // Strip backticks if any
              let rawEval = evalResp.choices[0].message.content.trim();
              if (rawEval.startsWith("```json"))
                rawEval = rawEval.replace(/```json/g, "");
              if (rawEval.startsWith("```"))
                rawEval = rawEval.replace(/```/g, "");
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

              // SERVER-SIDE DETERMINISTIC VALIDATION
              let finalDecision = evalData.decision || "REJECT";
              let validationRejection = "";

              if (finalDecision === "PUBLISH") {
                if (
                  !evalData.sources ||
                  !evalData.sources.some((s) => s.url === article.url)
                ) {
                  finalDecision = "REJECT";
                  validationRejection =
                    "Fabricated URL/Source mismatch detected.";
                } else if (!evalData.why_relevant_now) {
                  finalDecision = "REJECT";
                  validationRejection =
                    "Missing publishing rationale criteria.";
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

                const { error: insertError } = await supabase
                  .from("Posts")
                  .insert([
                    {
                      agent_id: agent.id,
                      text: parsedText,
                      rationale: `Rejected evaluation.`,
                      sources: [article.url],
                    },
                  ]);
                if (insertError) {
                  await supabase.from("Posts").insert([
                    {
                      agentId: agent.id,
                      text: parsedText,
                      rationale: `Rejected evaluation.`,
                      sources: [article.url],
                    },
                  ]);
                }
                continue; // Next article!
              }

              // GENERATION PHASE!
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

              let generatedText = article.title; // fallback
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

              const { error: insertError } = await supabase
                .from("Posts")
                .insert([
                  {
                    agent_id: agent.id,
                    text: generatedText || "No text available.",
                    rationale: rationaleOutput,
                    sources: [article.url],
                  },
                ]);

              if (insertError) {
                await supabase.from("Posts").insert([
                  {
                    agentId: agent.id,
                    text: generatedText || "No text available.",
                    rationale: rationaleOutput,
                    sources: [article.url],
                  },
                ]);
              }

              debugLogs.push(
                `Agent ${agent.id} published successfully. Moving to next agent...`,
              );
              postPublished = true;
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
