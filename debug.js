const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");
const env = fs
  .readFileSync(".env", "utf8")
  .split("\n")
  .reduce((acc, line) => {
    const parts = line.split("=");
    if (parts.length >= 2) {
      const k = parts.shift().trim();
      const v = parts.join("=").trim().replace(/"/g, "");
      acc[k] = v;
    }
    return acc;
  }, {});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

async function check() {
  const { data, error } = await supabase
    .from("CycleLogs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(5);
  const { data: posts } = await supabase
    .from("Posts")
    .select("id, status, scheduled_for, created_at, text, rationale")
    .order("created_at", { ascending: false })
    .limit(5);

  require("fs").writeFileSync(
    "debug.json",
    JSON.stringify({ logs: data, posts }, null, 2),
  );
}
check();
