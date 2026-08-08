function getStylePrompt(styleName = "Tech Storytelling") {
  try {
    if (styleName === "Casual") return require("./prompts/casual.js");
    if (styleName === "Creative Story") return require("./prompts/creative.js");
    if (styleName === "Human Voice") return require("./prompts/human.js");
    if (styleName === "News Brief") return require("./prompts/news.js");
    if (styleName === "Tech Creator")
      return require("./prompts/tech_creator.js");
    if (styleName === "Visual AI") return require("./prompts/visual.js");
    if (styleName === "Tech Storytelling")
      return require("./prompts/tech_story.js");
  } catch (e) {
    console.error("Missing prompt file for:", styleName);
  }

  // Fallback to basic if prompt file is empty/missing
  return `### ROLE ###\nYou are an AI assistant writing in the ${styleName} persona. Strictly follow the rules for ${styleName}.`;
}

async function fetchWithGroqFallback(prompt, groqKeys) {
  let lastError = null;
  const shuffledKeys = [...groqKeys].sort(() => 0.5 - Math.random());

  for (const key of shuffledKeys) {
    try {
      const resp = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
          }),
        },
      );
      const data = await resp.json();
      if (data.error) {
        lastError = data.error;
        if (data.error.code === "rate_limit_exceeded" || resp.status === 429) {
          continue;
        }
        throw new Error(JSON.stringify(data.error));
      }
      return data;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    "All Groq keys exhausted due to rate limits. Last error: " +
      JSON.stringify(lastError),
  );
}

module.exports = { getStylePrompt, fetchWithGroqFallback };
