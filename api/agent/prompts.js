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

module.exports = { getStylePrompt };
