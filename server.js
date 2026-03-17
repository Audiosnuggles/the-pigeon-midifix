const http = require("http");
const fs = require("fs");
const path = require("path");

const host = "127.0.0.1";
const port = Number(process.env.PORT || 8080);
const root = __dirname;
const securityHeaders = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN"
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".cur": "application/octet-stream"
};

function safePath(urlPath) {
  try {
    const decoded = decodeURIComponent(urlPath);
    const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
    return path.join(root, normalized);
  } catch (err) {
    return null;
  }
}

function toPresetName(fileBase) {
  return String(fileBase || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function isFloatersSource(src) {
  if (!src) return false;
  const id = String(src.id || "").toLowerCase();
  const name = String(src.name || "").toLowerCase();
  const url = String(src.url || "").toLowerCase();
  return (
    id === "floaters a"
    || id === "floaters_a"
    || id === "floaters-a"
    || name === "floaters a"
    || url.endsWith("/floaters a.json")
    || url.endsWith("/floaters_a.json")
    || url.endsWith("/floaters-a.json")
  );
}

function orderPresetSources(sources, includeStandard) {
  const list = Array.isArray(sources) ? sources.slice() : [];
  const standard = includeStandard ? { id: "standard_set", name: "Standard Set", url: "default_set.json" } : null;
  const floatersIdx = list.findIndex(isFloatersSource);
  const floaters = floatersIdx >= 0 ? list.splice(floatersIdx, 1)[0] : null;
  if (standard) return [standard, ...(floaters ? [floaters] : []), ...list];
  if (!floaters) return list;
  const first = list.shift();
  if (!first) return [floaters];
  return [first, floaters, ...list];
}

function writeSecureHead(res, statusCode, headers = {}) {
  res.writeHead(statusCode, {
    ...securityHeaders,
    ...headers
  });
}

const server = http.createServer((req, res) => {
  const requestPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];

  if (requestPath === "/api/preset-banks") {
    const presetsDir = path.join(root, "presets");
    fs.readdir(presetsDir, { withFileTypes: true }, (dirErr, entries) => {
      const dynamicSources = [];
      if (!dirErr && Array.isArray(entries)) {
        entries
          .filter(entry => (
            entry.isFile()
            && path.extname(entry.name).toLowerCase() === ".json"
            && entry.name.toLowerCase() !== "index.json"
          ))
          .sort((a, b) => a.name.localeCompare(b.name))
          .forEach(entry => {
            const base = path.basename(entry.name, ".json");
            dynamicSources.push({
              id: base,
              name: toPresetName(base),
              url: `presets/${entry.name}`
            });
          });
      }

      const standardPath = path.join(root, "default_set.json");
      fs.stat(standardPath, (standardErr, standardStats) => {
        const hasStandard = !standardErr && !!standardStats && standardStats.isFile();
        const sources = orderPresetSources(dynamicSources, hasStandard);

        writeSecureHead(res, 200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ sources }));
      });
    });
    return;
  }

  const fullPath = safePath(requestPath);

  if (!fullPath || (fullPath !== root && !fullPath.startsWith(root + path.sep))) {
    writeSecureHead(res, 403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.stat(fullPath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      writeSecureHead(res, 404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = mimeTypes[ext] || "application/octet-stream";
    writeSecureHead(res, 200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    const stream = fs.createReadStream(fullPath);
    stream.on("error", () => {
      if (res.writableEnded) return;
      writeSecureHead(res, 500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal server error");
    });
    stream.pipe(res);
  });
});

server.listen(port, host, () => {
  console.log(`The Pigeon dev server running at http://${host}:${port}`);
});
