const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { agentId } = JSON.parse(req.body);
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY,
    );

    // Deleting the agent also leverages Supabase CASCADING deletes if configured,
    // but we can explicitly delete posts first to prevent orphaned rows
    await supabase.from("Posts").delete().eq("agent_id", agentId);
    await supabase.from("Posts").delete().eq("agentId", agentId);

    const { error: delErr } = await supabase
      .from("Agents")
      .delete()
      .eq("id", agentId);
    if (delErr) throw delErr;

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
