const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY,
    );
    const { data, error } = await supabase
      .from("Agents")
      .select("*")
      .order("created_at", { ascending: false });

    const { count: globalPostsCount, error: countError } = await supabase
      .from("Posts")
      .select("*", { count: "exact", head: true });

    // Fetch real database size via Supabase RPC (requires get_db_size SQL function)
    let databaseSizeBytes = null;
    let rpcDebug = null;
    try {
      const { data: sizeData, error: rpcErr } =
        await supabase.rpc("get_db_size");
      if (!rpcErr && sizeData !== null) {
        databaseSizeBytes = sizeData;
      } else if (rpcErr) {
        rpcDebug = rpcErr.message || JSON.stringify(rpcErr);
      }
    } catch (e) {
      rpcDebug = e.message || "RPC threw exception";
    }

    if (error) throw error;
    if (countError) throw countError;

    return res.status(200).json({
      agents: data,
      globalPostsCount: globalPostsCount || 0,
      databaseSizeBytes,
      rpcDebug,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
