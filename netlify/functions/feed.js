const { createClient } = require("@supabase/supabase-js");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: "",
    };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    const { agentId } = event.queryStringParameters || {};

    if (!agentId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'Bad Request: "agentId" query parameter is required.',
        }),
      };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.warn("Supabase credentials missing from environment.");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Try finding posts for this agent.
    // Querying agent_id by default, but we can check if it fails.
    let { data, error } = await supabase
      .from("Posts")
      .select("*")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false });

    // Fallback if column might be named 'agentId' instead of 'agent_id'
    if (error && error.code === "42703") {
      // 42703 standard postgres undefined_column
      console.log("Column 'agent_id' not found, trying 'agentId'");
      const fallback = await supabase
        .from("Posts")
        .select("*")
        .eq("agentId", agentId)
        .order("created_at", { ascending: false });
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      console.error("Supabase select error:", error);
      throw error;
    }

    const posts = (data || []).map((post) => ({
      id: post.id || undefined,
      createdAt: post.created_at || post.createdAt || undefined,
      text: post.text || "",
      rationale: post.rationale || "",
      sources: post.sources || [],
    }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        posts,
      }),
    };
  } catch (error) {
    console.error("Internal Server Error:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Internal Server Error",
        details: error.message,
      }),
    };
  }
};
