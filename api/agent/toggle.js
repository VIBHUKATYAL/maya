const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { agentId, isActive } = JSON.parse(req.body);
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY,
    );

    const { data: agent, error: fetchErr } = await supabase
      .from("Agents")
      .select("*")
      .eq("id", agentId)
      .single();
    if (fetchErr) throw fetchErr;

    const persona = agent.persona || {};
    persona.isActive = isActive;

    const { error: updateErr } = await supabase
      .from("Agents")
      .update({ persona })
      .eq("id", agentId);
    if (updateErr) throw updateErr;

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
};
