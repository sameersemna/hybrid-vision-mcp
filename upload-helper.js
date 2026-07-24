import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

function getMimeTypeFromBuffer(buf) {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
    if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  }
  return null;
}

function isAlreadyResolved(input) {
  if (typeof input !== "string") return false;
  const trimmed = input.trim();
  return (
    trimmed.startsWith("data:image/") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("file://") ||
    trimmed.startsWith("upload://") ||
    trimmed.startsWith("~/")
  );
}

export class MCPUploadHelper {
  constructor(baseUrl = "http://localhost:11402") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.uploadUrl = `${this.baseUrl}/upload`;
  }

  async uploadImage(source) {
    if (typeof source === "string") {
      const trimmed = source.trim();
      if (isAlreadyResolved(trimmed)) {
        return trimmed;
      }
      throw new Error(`Unable to resolve image source: "${source}". Provide a file path, URL, Data URI, or upload a File/Blob.`);
    }

    if (source instanceof File || source instanceof Blob) {
      const buf = Buffer.from(await source.arrayBuffer());
      return await this._uploadBuffer(buf, source.type);
    }

    if (source instanceof ArrayBuffer) {
      const buf = Buffer.from(source);
      return await this._uploadBuffer(buf);
    }

    if (Buffer.isBuffer(source)) {
      return await this._uploadBuffer(source);
    }

    throw new Error(`Unsupported image source type: ${typeof source}. Expected File, Blob, ArrayBuffer, Buffer, or string.`);
  }

  async _uploadBuffer(buf, declaredType) {
    if (buf.length === 0) throw new Error("Image buffer is empty.");

    const mimeType = getMimeTypeFromBuffer(buf) || declaredType;
    if (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(`Unsupported image format. Allowed: ${Array.from(ALLOWED_MIME_TYPES).join(", ")}`);
    }

    const response = await fetch(this.uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": mimeType,
      },
      body: buf,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upload failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    if (!data.uploadRef) {
      throw new Error(`Upload response missing uploadRef: ${JSON.stringify(data)}`);
    }

    return data.uploadRef;
  }

  async callTool(toolName, args = {}, imageFields = ["image_source", "image_sources"]) {
    const resolvedArgs = { ...args };

    for (const field of imageFields) {
      if (!(field in resolvedArgs)) continue;

      const value = resolvedArgs[field];
      if (Array.isArray(value)) {
        const resolved = [];
        for (const item of value) {
          resolved.push(await this.uploadImage(item));
        }
        resolvedArgs[field] = resolved;
      } else if (value !== null && value !== undefined) {
        resolvedArgs[field] = await this.uploadImage(value);
      }
    }

    const transport = new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp`));
    const client = new Client({ name: "upload-helper-client", version: "1.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      const result = await client.callTool({ name: toolName, arguments: resolvedArgs });
      return result;
    } finally {
      await client.close();
    }
  }

  async connect() {
    this.transport = new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp`));
    this.client = new Client({ name: "upload-helper-client", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(this.transport);
    return this.client;
  }

  async callToolConnected(toolName, args = {}, imageFields = ["image_source", "image_sources"]) {
    if (!this.client) throw new Error("Helper not connected. Call connect() first.");

    const resolvedArgs = { ...args };
    for (const field of imageFields) {
      if (!(field in resolvedArgs)) continue;
      const value = resolvedArgs[field];
      if (Array.isArray(value)) {
        resolvedArgs[field] = await Promise.all(value.map((item) => this.uploadImage(item)));
      } else if (value !== null && value !== undefined) {
        resolvedArgs[field] = await this.uploadImage(value);
      }
    }

    return await this.client.callTool({ name: toolName, arguments: resolvedArgs });
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.transport = null;
    }
  }
}

export default MCPUploadHelper;
