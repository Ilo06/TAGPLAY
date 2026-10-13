import path from "node:path";
import { createApp } from "./app.js";

function fail(message: string): never {
  console.error(`tagplay: ${message}`);
  process.exit(1);
}

const adminKey = process.env.ADMIN_KEY;
if (!adminKey) fail("ADMIN_KEY is required and must not be empty");

const rawBaseUrl = process.env.BASE_URL;
if (!rawBaseUrl) fail("BASE_URL is required (e.g. https://tagplay.duckdns.org)");
try {
  new URL(rawBaseUrl);
} catch {
  fail(`BASE_URL is not a valid URL: ${rawBaseUrl}`);
}
const baseUrl = rawBaseUrl.replace(/\/+$/, "");

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail(`PORT is invalid: ${process.env.PORT}`);
}

const dataDir = path.resolve(process.env.DATA_DIR || "./data");

const app = createApp({ adminKey, baseUrl, dataDir });
// Local only: nginx is the public entry point.
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`tagplay listening on http://127.0.0.1:${port} (data: ${dataDir})`);
});
// Node's default 5 min limit on receiving a request would abort slow uploads
// of large files (nginx streams them through as they arrive).
server.requestTimeout = 0;
