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

let currentGroqIndex = 0;

async function fetchWithGroqFallback(
  prompt,
  groqKeys,
  model = "llama-3.3-70b-versatile",
  isJson = true,
) {
  let lastError = null;
  // Make sure we try up to essentially twice the length of the keys if needed
  const maxAttempts = groqKeys.length * 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = groqKeys[currentGroqIndex];

    try {
      const payload = {
        model: model,
        messages: [{ role: "user", content: prompt }],
      };
      if (isJson) {
        payload.response_format = { type: "json_object" };
      }

      const resp = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      const data = await resp.json();

      if (data.error) {
        lastError = data.error;
        if (data.error.code === "rate_limit_exceeded" || resp.status === 429) {
          console.log(
            `\n⚠️ Groq Key ${currentGroqIndex + 1} exhausted. Swapping to backup...`,
          );
          // Increment deterministically
          currentGroqIndex = (currentGroqIndex + 1) % groqKeys.length;

          // Small sleep to ensure we don't totally hammer the APIs if all keys are temporarily failing
          if (attempt >= groqKeys.length) {
            console.log(
              `Cycling keys again. Adaptive sleep to protect bucket...`,
            );
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
          continue;
        }
        throw new Error(JSON.stringify(data.error));
      }

      return data; // Success!
    } catch (e) {
      lastError = e;
      // If network error, still swap key just in case
      currentGroqIndex = (currentGroqIndex + 1) % groqKeys.length;
    }
  }

  throw new Error(
    "All Groq keys exhausted deterministically due to rate limits. Last error: " +
      JSON.stringify(lastError),
  );
}

module.exports = { getStylePrompt, fetchWithGroqFallback };
