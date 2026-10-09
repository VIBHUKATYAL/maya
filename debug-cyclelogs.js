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
  const { data: posts, error: postErr } = await supabase
    .from("Posts")
    .select("id, status, scheduled_for, created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  const { data, error } = await supabase
    .from("CycleLogs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);
  fs.writeFileSync(
    "debug_out.json",
    JSON.stringify({ logs: data, posts: posts, postErr }, null, 2),
  );
}
check();
