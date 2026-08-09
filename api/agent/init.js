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

    // Embed scheduling defaults onto the persona
    persona.maxPostsPerCycle = persona.maxPostsPerCycle || 4;
    persona.cycleIntervalMinutes = persona.cycleIntervalMinutes || 30;

    // 1. Initialize Agent
    const { data: agentData, error: agentError } = await supabase
      .from("Agents")
      .insert([{ persona }])
      .select("id")
      .single();

    if (agentError) throw agentError;
    const agentId = agentData.id || agentData.agentId;

    // Immediately trigger a synchronous generation cycle for the new agent, blocking until complete.
    // This restores the instantaneous first-post population requested by the UX.
    try {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers.host;
      if (host) {
        // Safeguard for offline / local-only tests
        await fetch(
          `${proto}://${host}/api/agent/cron?force=true&agentId=${agentId}`,
        );
        await fetch(`${proto}://${host}/api/agent/publisher`);
      }
    } catch (e) {
      console.error("Initial discovery dispatch failed:", e.message);
    }

    return res.status(200).json({ agentId });
  } catch (error) {
    console.error("Internal Server Error:", error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
};
