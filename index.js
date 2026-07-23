import express from "express";
import fs from "fs";
import crypto from "crypto";
import os from "os";
import { fileURLToPath } from "url";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ==========================================
// Process Guards
// ==========================================
process.on("uncaughtException", (err) => {
  console.error("[SERVER GUARD] Caught Uncaught Exception:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[SERVER GUARD] Caught Unhandled Rejection:", reason);
});

// ==========================================
// Configuration
// ==========================================
const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const VISION_MODEL_FAST = process.env.VISION_MODEL_FAST || "llava:13b";
const VISION_MODEL_HEAVY = process.env.VISION_MODEL_HEAVY || "qwen3-vl:30b";

// ==========================================
// Helper Functions & Image Validation
// ==========================================

function sanitizeBase64(input) {
  if (!input || typeof input !== "string") return "";
  let cleaned = input.trim();
  if (cleaned.includes("%")) {
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // fallback if not valid URI encoding
    }
  }
  // Replace space artifacts from HTTP query/body decoding back to '+'
  // and strip line breaks/whitespace
  return cleaned.replace(/ /g, "+").replace(/[\r\n\s]/g, "");
}

function isSupportedImageBuffer(buf) {
  if (!buf || buf.length < 4) return false;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // WEBP (RIFF)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  return false;
}

async function resolveImageToBuffer(input) {
  if (!input || typeof input !== "string") {
    throw new Error("Image input must be a non-empty string.");
  }

  let trimmed = input.trim();

  // 1. Data URI (e.g., data:image/png;base64,...)
  if (trimmed.startsWith("data:image/")) {
    const parts = trimmed.split(",");
    if (parts.length < 2) throw new Error("Invalid Data URI format.");
    const cleanBase64 = sanitizeBase64(parts[1]);
    const buf = Buffer.from(cleanBase64, "base64");
    if (!isSupportedImageBuffer(buf)) {
      throw new Error("Data URI payload does not contain valid binary image header bytes.");
    }
    return buf;
  }

  // 2. Handle file:// URI scheme
  if (trimmed.startsWith("file://")) {
    try {
      trimmed = fileURLToPath(trimmed);
    } catch {
      trimmed = trimmed.replace(/^file:\/\//, "");
    }
  }

  // 3. Handle ~ expansion for home directory
  if (trimmed.startsWith("~/") || trimmed === "~") {
    trimmed = trimmed.replace(/^~/, os.homedir());
  }

  // 4. HTTP / HTTPS URL
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const res = await fetch(trimmed, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HybridVisionMCP/1.0",
          "Accept": "image/png,image/jpeg,image/webp,image/*,*/*;q=0.8",
        },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/html") || contentType.includes("application/json")) {
        throw new Error(`URL returned content-type '${contentType}' instead of a valid image.`);
      }

      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      if (buf.length === 0) throw new Error("Fetched image payload is empty.");

      if (!isSupportedImageBuffer(buf)) {
        throw new Error("Fetched URL payload does not contain valid binary image headers.");
      }

      return buf;
    } catch (err) {
      throw new Error(`Failed to fetch image URL (${trimmed}): ${err.message}`);
    }
  }

  // 5. Local File Path (Only works if client and MCP server share a filesystem)
  if (fs.existsSync(trimmed)) {
    const buf = fs.readFileSync(trimmed);
    if (buf.length === 0) {
      throw new Error(`File at "${trimmed}" is 0 bytes (empty file).`);
    }
    if (!isSupportedImageBuffer(buf)) {
      throw new Error(`File found at "${trimmed}", but does not contain valid image header bytes.`);
    }
    return buf;
  }

  // 6. Pure Base64 String Fallback
  const cleanBase64 = sanitizeBase64(trimmed);
  if (cleanBase64.length > 50) {
    const buf = Buffer.from(cleanBase64, "base64");
    if (isSupportedImageBuffer(buf)) {
      return buf;
    }
  }

  throw new Error(
    `Unable to resolve image source. File not found on MCP server host at: "${trimmed}". Because the MCP server is hosted remotely, transmit the image as a Base64 Data URI ('data:image/png;base64,...') or an HTTP URL.`
  );
}

async function normalizeToPngBuffer(buffer) {
  try {
    return await sharp(buffer).toFormat("png").toBuffer();
  } catch (err) {
    if (err.message.includes("libpng read error") || err.message.includes("vipspng")) {
      throw new Error(
        `Image data was truncated or corrupted in transit (libpng read error). Check if the Base64 payload was truncated by LLM token limits.`
      );
    }
    throw new Error(`Unsupported or corrupted image data: ${err.message}`);
  }
}

async function queryOllamaVision(model, prompt, imageBuffers) {
  const imagesBase64 = imageBuffers.map((buf) => buf.toString("base64"));

  const payload = {
    model: model,
    prompt: prompt,
    images: imagesBase64,
    stream: false,
  };

  let response;
  try {
    response = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`Could not connect to Ollama service at ${OLLAMA_HOST}: ${err.message}`);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama API error (${response.status}): ${errText || response.statusText}`);
  }

  const data = await response.json();
  return data.response;
}

// ==========================================
// MCP Server Factory
// ==========================================
function createMcpServer() {
  const server = new Server(
    {
      name: "hybrid-vision-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const REMOTE_IMAGE_DESC = "Base64 Data URI (data:image/png;base64,...) or HTTP URL ONLY. Do NOT pass local file paths as the MCP server runs remotely.";

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "fast_ocr_tesseract",
          description: "Fast CPU-based WebAssembly OCR extraction for text in images.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: { type: "string", description: REMOTE_IMAGE_DESC },
              language: { type: "string", description: "Language code (e.g., 'eng', 'spa'). Default: 'eng'." },
            },
            required: ["image_source"],
          },
        },
        {
          name: "preprocess_and_crop",
          description: "Computer vision image preprocessing (crop, grayscale, sharpen) using Sharp.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: { type: "string", description: REMOTE_IMAGE_DESC },
              crop: {
                type: "object",
                properties: {
                  left: { type: "number" },
                  top: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" },
                },
                required: ["left", "top", "width", "height"],
              },
              grayscale: { type: "boolean" },
              sharpen: { type: "boolean" },
            },
            required: ["image_source"],
          },
        },
        {
          name: "analyze_image",
          description: "Analyze image contents or extract context using local Ollama Vision Models.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: { type: "string", description: REMOTE_IMAGE_DESC },
              prompt: { type: "string", description: "Question or instruction for analyzing the image." },
              model: { type: "string", description: "Optional Ollama vision model override." },
            },
            required: ["image_source"],
          },
        },
        {
          name: "find_text_element",
          description: "Locate specific text, UI elements, or objects visually within an image.",
          inputSchema: {
            type: "object",
            properties: {
              image_source: { type: "string", description: REMOTE_IMAGE_DESC },
              query: { type: "string", description: "Target text or element to locate." },
              model: { type: "string", description: "Optional Ollama vision model override." },
            },
            required: ["image_source", "query"],
          },
        },
        {
          name: "compare_images",
          description: "Compare two or more images side-by-side using local Ollama Vision Models.",
          inputSchema: {
            type: "object",
            properties: {
              image_sources: {
                type: "array",
                items: { type: "string", description: REMOTE_IMAGE_DESC },
                description: "Array of at least 2 Base64 Data URIs or HTTP URLs.",
              },
              prompt: { type: "string", description: "Comparison instructions." },
              model: { type: "string", description: "Optional Ollama vision model override." },
            },
            required: ["image_sources"],
          },
        },
        {
          name: "check_vision_health",
          description: "Check connectivity to local Ollama service and verify vision engines.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      if (name === "check_vision_health") {
        let ollamaStatus = "Disconnected";
        let modelsList = [];

        try {
          const res = await fetch(`${OLLAMA_HOST}/api/tags`);
          if (res.ok) {
            ollamaStatus = `Connected (${OLLAMA_HOST})`;
            const data = await res.json();
            modelsList = (data.models || []).map((m) => m.name);
          }
        } catch (e) {
          ollamaStatus = `Connection Error: ${e.message}`;
        }

        const healthText = [
          "=== Vision MCP Health Status ===",
          `- Ollama Service: ${ollamaStatus}`,
          `- Installed Ollama Models: ${modelsList.length > 0 ? modelsList.join(", ") : "None detected"}`,
          "- Tesseract OCR Engine: Ready (WebAssembly)",
          "- Sharp CV Engine: Ready",
        ].join("\n");

        return { content: [{ type: "text", text: healthText }] };
      }

      if (name === "fast_ocr_tesseract") {
        const rawBuf = await resolveImageToBuffer(args.image_source);
        const pngBuf = await normalizeToPngBuffer(rawBuf);
        const lang = args.language || "eng";

        const { data } = await Tesseract.recognize(pngBuf, lang);

        return {
          content: [
            {
              type: "text",
              text: `[Tesseract OCR Engine - Language: ${lang} - Confidence: ${data.confidence}%]\n\n${data.text || "(No text detected)"}`,
            },
          ],
        };
      }

      if (name === "preprocess_and_crop") {
        const rawBuf = await resolveImageToBuffer(args.image_source);
        let pipeline = sharp(rawBuf);

        if (args.crop) {
          const meta = await pipeline.metadata();
          const imgWidth = meta.width || 1;
          const imgHeight = meta.height || 1;

          const cropLeft = Math.round(args.crop.left || 0);
          const cropTop = Math.round(args.crop.top || 0);
          const cropWidth = Math.round(args.crop.width || 1);
          const cropHeight = Math.round(args.crop.height || 1);

          if (cropLeft < 0 || cropTop < 0 || cropWidth <= 0 || cropHeight <= 0) {
            throw new Error("Crop dimensions must be positive numbers.");
          }

          if (cropLeft >= imgWidth || cropTop >= imgHeight) {
            throw new Error("Crop region starts outside the image boundaries.");
          }

          if (cropLeft + cropWidth > imgWidth || cropTop + cropHeight > imgHeight) {
            throw new Error("Crop region exceeds image boundaries.");
          }

          pipeline = pipeline.extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight });
        }

        if (args.grayscale) {
          pipeline = pipeline.grayscale();
        }
        if (args.sharpen) {
          pipeline = pipeline.sharpen();
        }

        const processedBuffer = await pipeline.toBuffer();
        const base64 = processedBuffer.toString("base64");

        return {
          content: [
            {
              type: "text",
              text: `Image preprocessed successfully. Output Base64 data (length: ${base64.length} chars).\nData URI: data:image/png;base64,${base64.slice(0, 100)}...`,
            },
          ],
        };
      }

      if (name === "analyze_image") {
        const rawBuf = await resolveImageToBuffer(args.image_source);
        await normalizeToPngBuffer(rawBuf);

        const prompt = args.prompt || "Describe this image in detail.";
        const model = args.model || VISION_MODEL_FAST;

        const textResult = await queryOllamaVision(model, prompt, [rawBuf]);
        return { content: [{ type: "text", text: textResult }] };
      }

      if (name === "find_text_element") {
        const rawBuf = await resolveImageToBuffer(args.image_source);
        await normalizeToPngBuffer(rawBuf);

        if (!args.query) throw new Error("Parameter 'query' is required.");

        const prompt = `Locate the element or text matching: "${args.query}". Provide the bounding box coordinates or visual position within the image.`;
        const model = args.model || VISION_MODEL_HEAVY;

        const textResult = await queryOllamaVision(model, prompt, [rawBuf]);
        return { content: [{ type: "text", text: textResult }] };
      }

      if (name === "compare_images") {
        if (!Array.isArray(args.image_sources) || args.image_sources.length < 2) {
          throw new Error("Parameter 'image_sources' must be an array of at least 2 image inputs.");
        }

        const buffers = [];
        for (const src of args.image_sources) {
          const buf = await resolveImageToBuffer(src);
          await normalizeToPngBuffer(buf);
          buffers.push(buf);
        }

        const prompt = args.prompt || "Compare these images in detail and highlight any differences or similarities.";
        const model = args.model || VISION_MODEL_HEAVY;

        const textResult = await queryOllamaVision(model, prompt, buffers);
        return { content: [{ type: "text", text: textResult }] };
      }

      throw new Error(`Unknown tool requested: ${name}`);
    } catch (err) {
      console.error(`[Tool Execution Error - ${name}]:`, err.message);
      return {
        content: [
          {
            type: "text",
            text: `Error executing tool '${name}': ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// ==========================================
// Express App & Routing
// ==========================================
const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.status(200).send("Hybrid Vision MCP Server Active.");
});

// Streamable HTTP Transports (/mcp)
const streamableTransports = new Map();

app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] || req.query.sessionId;
  let transport = streamableTransports.get(sessionId);

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        streamableTransports.set(id, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        streamableTransports.delete(transport.sessionId);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

// SSE Transports (/sse and /messages)
const sseTransports = new Map();

app.get("/sse", async (req, res) => {
  console.log(`[HTTP] ${new Date().toLocaleTimeString()} -> GET /sse`);

  const transport = new SSEServerTransport("/messages", res);
  sseTransports.set(transport.sessionId, transport);

  transport.onclose = () => {
    console.log(` -> SSE connection closed for session: ${transport.sessionId}`);
    sseTransports.delete(transport.sessionId);
  };

  const server = createMcpServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    res.status(400).send("Missing sessionId query parameter.");
    return;
  }

  const transport = sseTransports.get(sessionId);
  if (!transport) {
    res.status(404).send("Session not found");
    return;
  }

  await transport.handlePostMessage(req, res, req.body);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
========================================
 Hybrid Vision MCP Server Running 
 Listening on: http://0.0.0.0:${PORT}
 - Streamable HTTP: http://localhost:${PORT}/mcp
 - SSE Endpoint:    http://localhost:${PORT}/sse
========================================
`);
});