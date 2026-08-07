const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { agentId } = req.query;

    if (!agentId)
      return res
        .status(400)
        .json({ error: 'Bad Request: "agentId" query parameter required.' });

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY,
    );

    let { data, error } = await supabase
      .from("Posts")
      .select("*")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false });

    if (error && error.code === "42703") {
      const fallback = await supabase
        .from("Posts")
        .select("*")
        .eq("agentId", agentId)
        .order("created_at", { ascending: false });
      data = fallback.data;
      error = fallback.error;
    }

    if (error) throw error;

    const posts = (data || []).map((post) => ({
      id: post.id || undefined,
      createdAt: post.created_at || post.createdAt || undefined,
      text: post.text || "",
      rationale: post.rationale || "",
      sources: post.sources || [],
    }));

    return res.status(200).json({ posts });
  } catch (error) {
    console.error("Internal Server Error:", error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
};
