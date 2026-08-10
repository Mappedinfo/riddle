import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const dist = join(root, "dist");
const env = await loadEnv(join(root, ".env"));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const apiBase = (process.env.QWEN_API_URL || env.QWEN_API_URL || process.env.DEEPSEEK_API_URL || env.DEEPSEEK_API_URL || "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
const apiKey = process.env.QWEN_AI_KEY || env.QWEN_AI_KEY || process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || "";
const model = process.env.QWEN_API_MODEL || env.QWEN_API_MODEL || process.env.DEEPSEEK_API_MODEL || env.DEEPSEEK_API_MODEL || "qwen3.8-max";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "POST" && url.pathname === "/api/oracle") {
      if (!apiKey) return json(response, 503, { error: "No oracle API key is configured." });
      const body = JSON.parse(await readBody(request));
      body.model = model;
      const upstream = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "Method not allowed" });
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const safePath = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
    let data;
    let filePath = join(dist, safePath);
    try {
      data = await readFile(filePath);
    } catch {
      filePath = join(dist, "index.html");
      data = await readFile(filePath);
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": extname(filePath) === ".html" || filePath.endsWith("sw.js") ? "no-cache" : "public, max-age=31536000, immutable",
    });
    response.end(request.method === "HEAD" ? undefined : data);
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : "Internal server error" });
  }
}).listen(port, host, () => {
  console.log(`Riddle Web listening on http://${host}:${port}`);
});

async function loadEnv(path) {
  try {
    const text = await readFile(path, "utf8");
    return Object.fromEntries(text.split(/\r?\n/).filter((line) => line && !line.trimStart().startsWith("#")).map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, "$2")];
    }).filter(([key]) => key));
  } catch {
    return {};
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
