const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const { SUPABASE_URL, SUPABASE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res
        .status(500)
        .json({ error: "Missing required Vercel Environment Variables!" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Fetch all SCHEDULED posts where scheduled_for is in the past!
    const { data: duePosts, error: fetchError } = await supabase
      .from("Posts")
      .select("id")
      .eq("status", "SCHEDULED")
      .lte("scheduled_for", new Date().toISOString());

    if (fetchError) throw fetchError;

    if (!duePosts || duePosts.length === 0) {
      return res
        .status(200)
        .json({ status: "No posts due for publication", publishedCount: 0 });
    }

    const postIds = duePosts.map((p) => p.id);

    // Atomic update status = 'PUBLISHED'
    const { data: updateData, error: updateError } = await supabase
      .from("Posts")
      .update({ status: "PUBLISHED" })
      .in("id", postIds)
      .select();

    if (updateError) throw updateError;

    return res.status(200).json({
      status: "Success",
      publishedCount: updateData.length,
      publishedIds: postIds,
    });
  } catch (error) {
    console.error("Internal Server Error:", error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
};
