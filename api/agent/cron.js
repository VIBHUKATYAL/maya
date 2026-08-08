const { createClient } = require("@supabase/supabase-js");
const { tavily } = require("@tavily/core");
const { getStylePrompt } = require("../../lib/prompts.js");
const { getEditorialPrompt } = require("../../lib/prompts/editorale.js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const debugLogs = [];

  try {
    const { SUPABASE_URL, SUPABASE_KEY } = process.env;
    const tvlyKeys = (process.env.TAVILY_API_KEY || "tvly-kX03O8N")
      .split(",")
      .map((k) => k.trim());
    const TAVILY_API_KEY =
      tvlyKeys[Math.floor(Math.random() * tvlyKeys.length)];

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
          // Shuffle and pick 4 randomly for wider fallback pool
          const searchQueries = allQueries
            .sort(() => 0.5 - Math.random())
            .slice(0, 4);

          let postPublished = false;
          let groqEvals = 0;

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
          const groqKeys = (process.env.GROQ_API_KEY || groqFallback)
            .split(",")
            .map((k) => k.trim());
          const GROQ_API_KEY =
            groqKeys[Math.floor(Math.random() * groqKeys.length)];

          for (const query of searchQueries) {
            if (postPublished) break; // Break outer loop completely if we found a good post!

            debugLogs.push(`Searching Tavily for: ${query}`);
            const searchResponse = await tvly.search(query, {
              searchDepth: "basic",
              topic: "news",
              maxResults: 10,
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
                    overlap /
                    Math.max(
                      1,
                      Math.min(articleKeywords.size, postKeywords.size),
                    );
                  // Stricter string-based similarity filter: if 35% of the title overlaps entirely with any past post text, KILL it.
                  if (similarity > 0.35) {
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

              if (groqEvals >= 3) {
                debugLogs.push(
                  `Throttling execution early to prevent Vercel Timeout limit.`,
                );
                break; // Break the inner article evaluation loop!
              }
              groqEvals++;

              debugLogs.push(
                `Evaluating article sequentially via Groq: ${article.title}`,
              );

              // THROTTLE TO PREVENT GROQ 429 RATE LIMITS (Max 30 requests/min free tier)
              await new Promise((resolve) => setTimeout(resolve, 900));

              const safeContent = (article.content || "")
                .substring(0, 1500)
                .concat("...");

              const evalPrompt = getEditorialPrompt({
                domain,
                articleTitle: article.title,
                articleContent: safeContent,
                articleUrl: article.url,
                memoryContext,
              });

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
              if (evalResp.error) {
                throw new Error(
                  "Groq Eval API failed: " + JSON.stringify(evalResp.error),
                );
              }

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
              const styleRules = getStylePrompt(
                persona.writingStyle || "Tech Storytelling",
              );

              const safeWriteContent = (article.content || "")
                .substring(0, 2500)
                .concat("...");

              const writePrompt = `### ROLE ###\nYou are ${persona.name}, a highly opinionated expert in ${domain}.\nMaintain stable interests, a coherent voice, and distinct editorial opinions relevant to your domain.\nYou have just received an approved editorial topic. Your ONLY job is to write the post based on the Editor's exact rationale, STRICTLY following the Writing Style Rules below.\n\n### EDITOR'S RATIONALE ###\nTopic: ${evalData.topic || article.title}\nWhy it was selected: ${evalData.why_selected}\nRelevance: ${evalData.why_relevant_now}\n\n### ARTICLE CONTEXT ###\nTitle: ${article.title}\nContent: ${safeWriteContent}\nURL: ${article.url}\n\n${styleRules}\n\n### OUTPUT FORMAT ###\nOutput ONLY valid JSON:\n{\n  "text": "The final structured markdown text following the provided writing style perfectly, without any forced emojis."\n}`;

              // THROTTLE TO PREVENT GROQ 429 RATE LIMITS (Max 30 requests/min free tier)
              await new Promise((resolve) => setTimeout(resolve, 900));

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
              if (writeResp.error) {
                throw new Error(
                  "Groq Write API failed: " + JSON.stringify(writeResp.error),
                );
              }

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
