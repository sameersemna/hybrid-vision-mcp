import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildFixturePng } from "../lib/fixtures.js";
const dataUri = "data:image/png;base64," + (await buildFixturePng()).toString("base64");
const client = new Client({ name: "f5b", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:11499/mcp")));
const t0 = Date.now();
const r = await client.callTool({ name: "analyze_image_structured", arguments: {
  image_source: dataUri, prompt: "Describe the image.", model: "minicpm-v:8b", timeout_ms: 3000,
}}, undefined, { timeout: 60000 });
console.log("elapsed:", Date.now()-t0, "ms | isError:", r.isError);
console.log("--- full error payload as an agent would see it ---");
console.log(r.content[0].text);
await client.close();
