import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const presetsDir = path.join(rootDir, "presets");
const outPath = path.join(presetsDir, "index.json");

function toName(id) {
  return String(id || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function isFloatersName(name) {
  const lower = String(name || "").toLowerCase();
  return (
    lower === "floaters a.json"
    || lower === "floaters_a.json"
    || lower === "floaters-a.json"
  );
}

async function main() {
  const entries = await fs.readdir(presetsDir, { withFileTypes: true });
  const allSources = entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name.toLowerCase().endsWith(".json"))
    .filter(name => name.toLowerCase() !== "index.json")
    .sort((a, b) => a.localeCompare(b))
    .map(name => {
      const id = name.replace(/\.json$/i, "");
      return {
        id,
        name: toName(id),
        url: `presets/${name}`
      };
    });

  const floaters = allSources.find(src => isFloatersName(path.basename(src.url || ""))) || null;
  const restSources = floaters ? allSources.filter(src => src !== floaters) : allSources;
  const sources = floaters ? [floaters, ...restSources] : restSources;

  const payload = {
    sources: [
      { id: "standard_set", name: "Standard Set", url: "default_set.json" },
      ...sources
    ]
  };

  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
