const { createClient } = require("@supabase/supabase-js");
const { tavily } = require("@tavily/core");
const {
  getStylePrompt,
  fetchWithGroqFallback,
} = require("../../lib/prompts.js");
const { getEditorialPrompt } = require("../../lib/prompts/editorale.js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const debugLogs = [];

  try {
    const { SUPABASE_URL, SUPABASE_KEY } = process.env;
    const tvlyKeys = (process.env.TAVILY_API_KEY || "tvly-kX03O8N")
      .split(",")
      .map((k) => k.trim());
    const getTvlyKey = () =>
      tvlyKeys[Math.floor(Math.random() * tvlyKeys.length)];

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res
        .status(500)
        .json({ error: "Missing required Vercel Environment Variables!" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Automatically flush due scheduled queue items on every cron ping
    try {
      await supabase
        .from("Posts")
        .update({ status: "PUBLISHED" })
        .eq("status", "SCHEDULED")
        .lte("scheduled_for", new Date().toISOString());
    } catch (err) {
      console.error("Failed to flush scheduled queue", err);
    }

    let queryObj = supabase.from("Agents").select("*");
    if (req.query && req.query.agentId) {
      queryObj = queryObj.eq("id", req.query.agentId);
    }

    const { data: agents, error: agentFetchError } = await queryObj;
    if (agentFetchError)
      throw new Error(
        "Failed to fetch agents: " + JSON.stringify(agentFetchError),
      );
    if (!agents || agents.length === 0)
      return res.status(200).json({ status: "No active agents", debugLogs });

    const executionStart = Date.now();
    const VERCEL_SAFE_TIMEOUT = 15000; // 15 seconds! (If an agent takes 40s to run, we DO NOT risk starting another if we're past 15s)

    for (const agent of agents) {
      // Prevent Vercel hobby plan 60s timeout by gracefully yielding batches
      if (
        !req.query.agentId &&
        Date.now() - executionStart > VERCEL_SAFE_TIMEOUT
      ) {
        debugLogs.push(
          "Approaching Vercel execution limits (45s). Halting batch processor gracefully. Remaining agents queued for next interval.",
        );
        break;
      }

      let cycleStarted = new Date();
      let cycleStatus = "SUCCESS";
      let postsScheduled = 0;
      let cycleError = null;

      try {
        const persona = agent.persona || {};
        if (persona.isActive === false) continue; // SKIP PAUSED AGENTS

        const maxPosts = Math.min(persona.maxPostsPerCycle || 4, 4);
        const intervalMins = persona.cycleIntervalMinutes || 30;

        const forceRun = req.query.force === "true";

        // Check if agent is due for a new discovery cycle
        if (!forceRun) {
          const lastIntervalDate = new Date(Date.now() - intervalMins * 60000);
          const { data: recentLogs } = await supabase
            .from("CycleLogs")
            .select("created_at")
            .eq("agent_id", agent.id)
            .eq("status", "SUCCESS")
            .gte("created_at", lastIntervalDate.toISOString())
            .order("created_at", { ascending: false })
            .limit(1);

          if (recentLogs && recentLogs.length > 0) {
            debugLogs.push(
              `Skipping agent ${agent.id} – cycle interval (${intervalMins}m) has not passed yet.`,
            );
            continue;
          }
        }

        debugLogs.push(`Starting Discovery Cycle for agent ${agent.id}`);

        // Purge any stale SCHEDULED queue blocks for this agent to cleanly start a fresh discovery pipeline
        await supabase
          .from("Posts")
          .delete()
          .eq("agent_id", agent.id)
          .eq("status", "SCHEDULED");

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
        // Shuffle and pick multiple candidate branches
        const searchQueries = allQueries
          .sort(() => 0.5 - Math.random())
          .slice(0, 4);

        // Pull Memory to prevent repeating content!
        const { data: posts } = await supabase
          .from("Posts")
          .select("text, rationale")
          .eq("agent_id", agent.id)
          .order("created_at", { ascending: false })
          .limit(15);

        const memoryContext =
          posts && posts.length > 0
            ? posts
                .map((p) => {
                  const isRejected = p.text.startsWith("[REJECTED]");
                  const type = isRejected
                    ? "PREVIOUSLY REJECTED"
                    : "PREVIOUSLY PUBLISHED";
                  const snippet = (typeof p.text === "string" ? p.text : "")
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
        const getGroqKey = () =>
          groqKeys[Math.floor(Math.random() * groqKeys.length)];

        let approvedCandidates = [];
        let groqEvals = 0;

        // DISCOVERY & EDITORIAL EVALUATION
        for (const query of searchQueries) {
          if (approvedCandidates.length >= maxPosts) break;

          const tvly = tavily({ apiKey: getTvlyKey() });
          debugLogs.push(`Searching Tavily for: ${query}`);
          const searchResponse = await tvly.search(query, {
            searchDepth: "basic",
            topic: "news",
            maxResults: 4,
          });

          if (!searchResponse || !searchResponse.results) continue;

          for (const article of searchResponse.results) {
            if (approvedCandidates.length >= maxPosts) break;

            // JACCARD DUPLICATE ALGORITHM
            const getKeywords = (text) => {
              const words = (text || "")
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, "")
                .split(/\s+/);
              return new Set(words.filter((w) => w.length > 4));
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
                if (similarity > 0.65) {
                  isExactDuplicate = true;
                  break;
                }
              }
            }

            if (isExactDuplicate) {
              debugLogs.push(
                `Blocked Duplicate Algorithmically: ${article.title}`,
              );
              continue; // HARD SKIP
            }

            if (groqEvals >= 4) {
              break; // Throttle to prevent Webhook 30s Timeout & TPM Exhausion
            }
            groqEvals++;

            debugLogs.push(
              `Evaluating article sequentially via Groq: ${article.title}`,
            );
            await new Promise((resolve) => setTimeout(resolve, 900));

            const safeContent = (article.content || "")
              .substring(0, 800)
              .concat("...");
            const evalPrompt = getEditorialPrompt({
              domain,
              articleTitle: article.title,
              articleContent: safeContent,
              articleUrl: article.url,
              memoryContext,
            });

            let evalResp;
            try {
              evalResp = await fetchWithGroqFallback(
                evalPrompt,
                [groqKeys[0]],
                "llama-3.1-8b-instant",
                true,
              );
            } catch (err) {
              debugLogs.push(`API Exhaustion during Eval: ${err.message}`);
              await supabase.from("Posts").insert([
                {
                  agent_id: agent.id,
                  text: `[REJECTED]\n**Topic:** ${article.title}\n\n**Why Rejected:** ⚠️ Groq API Rate Limit Completely Exhausted! The LLM engine failed to evaluate this candidate natively because your token buckets are empty. Switch to a smaller model or add more keys.`,
                  rationale: "API Rate Limit Exhaustion",
                  sources: [article.url],
                  status: "REJECTED",
                },
              ]);
              cycleStatus = "FAILED";
              cycleError = "API Rate Limit Exhaustion during Evaluation";
              break;
            }

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
                validationRejection = "Missing publishing rationale criteria.";
              } else if (evalData.score && evalData.score < 40) {
                finalDecision = "REJECT";
                validationRejection =
                  "Topic scored too low logically to securely publish (Score < 40).";
              }
            }

            if (finalDecision === "PUBLISH") {
              approvedCandidates.push({
                article,
                evalData,
                score: evalData.score || 80,
              });
            } else {
              const combinedReason =
                validationRejection ||
                evalData.rejection_reason ||
                "Rejected by strict editorial logic.";
              const parsedText = `[REJECTED]\n**Topic:** ${evalData.topic || article.title}\n\n**Why Rejected:** ${combinedReason}`;

              const { error: insertError } = await supabase
                .from("Posts")
                .insert([
                  {
                    agent_id: agent.id,
                    text: parsedText,
                    rationale: combinedReason,
                    sources: [article.url],
                    status: "REJECTED",
                  },
                ]);
              if (insertError) {
                await supabase.from("Posts").insert([
                  {
                    agentId: agent.id,
                    text: parsedText,
                    rationale: combinedReason,
                    sources: [article.url],
                    status: "REJECTED",
                  },
                ]);
              }
            }
          }
        }

        // GENERATION & SCHEDULING PHASE
        if (approvedCandidates.length > 0) {
          // Sort by score ascending so the best is processed last? Or descending.
          approvedCandidates.sort((a, b) => b.score - a.score);
          const finalCandidates = approvedCandidates.slice(0, maxPosts);

          const styleRules = getStylePrompt(
            persona.style || persona.writingStyle || "Tech Storytelling",
          );

          const now = Date.now();
          // Distribute evenly across the interval minutes (e.g., if 4 posts across 30 mins -> post every 7.5 mins)
          const timeSpacingMs =
            finalCandidates.length > 1
              ? (intervalMins * 60000) / finalCandidates.length
              : 0;

          for (let i = 0; i < finalCandidates.length; i++) {
            const cand = finalCandidates[i];

            const safeWriteContent = (cand.article.content || "")
              .substring(0, 1200)
              .concat("...");
            const writePrompt = `### ROLE ###\nYou are ${persona.name}, a highly opinionated expert in ${domain}.\nMaintain stable interests, a coherent voice, and distinct editorial opinions relevant to your domain.\nYou have just received an approved editorial topic. Your ONLY job is to write the post based on the Editor's exact rationale, STRICTLY following the Writing Style Rules below.\n\n### EDITOR'S RATIONALE ###\nTopic: ${cand.evalData.topic || cand.article.title}\nWhy it was selected: ${cand.evalData.why_selected}\nRelevance: ${cand.evalData.why_relevant_now}\n\n### ARTICLE CONTEXT ###\nTitle: ${cand.article.title}\nContent: ${safeWriteContent}\nURL: ${cand.article.url}\n\n${styleRules}\n\n### OUTPUT FORMAT ###\nDO NOT output JSON or any brackets. Write exclusively pure Markdown plain text representing the entire final article dynamically structured into strictly 6 paragraphs properly formatted with double newlines. Output ONLY the article text.`;

            const generatorPayload = JSON.stringify({
              writePrompt,
              why_selected: cand.evalData.why_selected,
              why_relevant_now: cand.evalData.why_relevant_now,
            });

            const scheduledDate = new Date(
              now + timeSpacingMs * i,
            ).toISOString();

            const { error: insertError } = await supabase.from("Posts").insert([
              {
                agent_id: agent.id,
                text: "[PENDING_GENERATION]",
                rationale: generatorPayload,
                sources: [cand.article.url],
                status: "SCHEDULED",
                scheduled_for: scheduledDate,
              },
            ]);

            if (insertError) {
              console.error(
                "Falling back on standard agentId insert",
                insertError,
              );
              await supabase.from("Posts").insert([
                {
                  agentId: agent.id,
                  text: "[PENDING_GENERATION]",
                  rationale: generatorPayload,
                  sources: [cand.article.url],
                  status: "SCHEDULED",
                  scheduled_for: scheduledDate,
                },
              ]);
            }
            postsScheduled++;
            debugLogs.push(
              `Agent ${agent.id} scheduled post +${Math.round((timeSpacingMs * i) / 60000)}m...`,
            );
          }
        }
      } catch (e) {
        cycleStatus = "FAILED";
        cycleError = e.message || JSON.stringify(e);
        console.error(`Error processing agent ${agent.id}:`, cycleError);
        debugLogs.push(`FAILED agent ${agent.id} -> ${cycleError}`);
      }

      // Log Cycle metrics
      await supabase.from("CycleLogs").insert([
        {
          agent_id: agent.id,
          started_at: cycleStarted.toISOString(),
          finished_at: new Date().toISOString(),
          status: cycleStatus,
          posts_scheduled: postsScheduled,
          error: cycleError,
        },
      ]);
    }

    return res
      .status(200)
      .json({ status: "Vercel Discovery Cycle Complete", logs: debugLogs });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
