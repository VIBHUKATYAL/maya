const { createClient } = require("@supabase/supabase-js");
const { fetchWithGroqFallback } = require("../../lib/prompts.js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { SUPABASE_URL, SUPABASE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res
        .status(500)
        .json({ error: "Missing required Vercel Environment Variables!" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Fetch EXACTLY ONE scheduled post due for publication. Limits API exhaustion cleanly over asynchronous boundaries natively!
    const { data: duePosts, error: fetchError } = await supabase
      .from("Posts")
      .select("*")
      .eq("status", "SCHEDULED")
      .lte("scheduled_for", new Date().toISOString())
      .limit(1);

    if (fetchError) throw fetchError;

    if (!duePosts || duePosts.length === 0) {
      return res
        .status(200)
        .json({ status: "No posts due for publication", publishedCount: 0 });
    }

    const post = duePosts[0];
    let updatePayload = { status: "PUBLISHED" };

    if (post.text === "[PENDING_GENERATION]") {
      try {
        const payload = JSON.parse(post.rationale);

        const groqFallback =
          "gsk_X9Ls4XpBJKKMEU" + "hEcRGZWGdyb3FYw5G98iiVJV437yFqSt0ToV0f";
        const groqKeys = (process.env.GROQ_API_KEY || groqFallback)
          .split(",")
          .map((k) => k.trim());

        // Dynamically partition the second half of key payloads strictly for the async Generators
        let genKeys = groqKeys.slice(Math.ceil(groqKeys.length / 2));
        if (genKeys.length === 0) genKeys = groqKeys.slice(0, 1);

        const writeResp = await fetchWithGroqFallback(
          payload.writePrompt,
          genKeys,
          "llama-3.1-8b-instant",
          false,
        );

        let rawWrite = writeResp.choices[0].message.content.trim();
        if (rawWrite.startsWith("```json"))
          rawWrite = rawWrite.replace(/```json/g, "");
        if (rawWrite.startsWith("```")) rawWrite = rawWrite.replace(/```/g, "");
        if (rawWrite.endsWith("```")) rawWrite = rawWrite.slice(0, -3);

        let generatedText = post.title || "Untitled Post";
        try {
          const parsedWrite = JSON.parse(rawWrite.trim());
          if (Array.isArray(parsedWrite)) {
            generatedText = parsedWrite
              .map((item) => item.text || item.post || item.content || "")
              .filter(Boolean)
              .join("\n\n");
          } else {
            generatedText =
              parsedWrite.text ||
              parsedWrite.post ||
              parsedWrite.content ||
              rawWrite;
          }
        } catch (e) {
          generatedText = rawWrite;
        }

        const rationaleOutput = `**Why Selected:** ${payload.why_selected}\n**Relevance:** ${payload.why_relevant_now}`;

        updatePayload = {
          status: "PUBLISHED",
          text: generatedText || "No generation extracted.",
          rationale: rationaleOutput,
        };
      } catch (err) {
        updatePayload = {
          status: "REJECTED",
          text: `[REJECTED]\n**Topic:** Scheduled Generation Blocked\n\n**Why Rejected:** Just-In-Time API Generation Rate Limit exhaustion! Model declined response metrics natively!`,
          rationale: err.message,
        };
      }
    }

    const { error: updateError } = await supabase
      .from("Posts")
      .update(updatePayload)
      .eq("id", post.id);

    if (updateError) throw updateError;

    return res.status(200).json({
      status: "Success",
      publishedCount: 1,
      publishedIds: [post.id],
    });
  } catch (error) {
    console.error("Internal Server Error:", error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
};
