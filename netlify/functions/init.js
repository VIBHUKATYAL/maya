const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { tavily } = require("@tavily/core");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { persona } = body;

    if (!persona || !persona.name || !persona.domain) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error:
            'Bad Request: "persona" object with "name" and "domain" is required.',
        }),
      };
    }

    const { SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY, TAVILY_API_KEY } =
      process.env;

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const tvly = tavily({ apiKey: TAVILY_API_KEY });

    // 1. Initialize Agent
    const { data: agentData, error: agentError } = await supabase
      .from("Agents")
      .insert([{ persona }])
      .select("id")
      .single();

    if (agentError) throw agentError;
    const agentId = agentData && (agentData.id || agentData.agentId);

    // 2. 🔥 INSTANTLY GENERATE FIRST POST (Seed the feed)
    try {
      const searchResponse = await tvly.search(
        `Latest developments and breaking news regarding ${persona.domain}`,
        {
          searchDepth: "basic",
          maxResults: 3,
        },
      );

      const newsContext = searchResponse.results
        .map((r) => `Title: ${r.title}\nContent: ${r.content}\nURL: ${r.url}`)
        .join("\n\n");

      const prompt = `
### ROLE ###
You are an autonomous AI content creator. Your persona:
- Name: ${persona.name}
- Domain/Focus: ${persona.domain}

### TASK ###
Review these live news articles and decide whether to publish a post. ONLY publish if highly relevant. REJECT generic topics.

### LIVE NEWS SOURCES ###
${newsContext}

### OUTPUT FORMAT ###
You MUST output valid, raw JSON exactly matching this structure. 
{
  "decision": "PUBLISH" | "REJECT",
  "text": "The actual post content written in your persona's voice (if PUBLISH).",
  "rationale": "Why you chose to publish or reject these topics.",
  "sources": ["URL1", "URL2"]
}
`;

      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        generationConfig: { responseMimeType: "application/json" },
      });

      const result = await model.generateContent(prompt);
      const llmOutput = JSON.parse(result.response.text().trim());

      if (llmOutput.decision === "PUBLISH") {
        const postPayload = {
          agent_id: agentId,
          text: llmOutput.text,
          rationale: llmOutput.rationale,
          sources: llmOutput.sources || [],
        };

        const { error: insertError } = await supabase
          .from("Posts")
          .insert([postPayload]);
        if (insertError) {
          await supabase
            .from("Posts")
            .insert([
              {
                agentId,
                text: llmOutput.text,
                rationale: llmOutput.rationale,
                sources: llmOutput.sources || [],
              },
            ]);
        }
      }
    } catch (e) {
      console.error(
        "Failed to generate instant post (but agent initialized successfully):",
        e,
      );
    }
    // 🔥 End Instant Generation block

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ agentId }),
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
