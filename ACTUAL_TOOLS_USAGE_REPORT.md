# Hybrid Vision MCP Server — Actual Tool Usage Report

**Generated:** 2026-07-22T23:59:15.899Z
**Server URL:** http://localhost:11402

---

## Test Images Used

- **textImage**: [Generated 400x100 white background with black text: "HYBRID VISION TEST 123"]
- **uiImage**: [Generated 500x200 UI mockup with "Hello World", "OCR Test 456", and "Submit" button]
- **multiObjectImage**: [Generated 300x300 white with red rect and blue circle]
- **secondImage**: [Generated 300x300 yellow with green circle]

---

## Tool Invocation Results

### check_vision_health

**Duration:** 27ms

**Output:**

```
=== Vision MCP Health Status ===
- Ollama Service: Connected (http://localhost:11434)
- Installed Ollama Models: 4skl/gemma4-e4b-mtp:latest, aiasistentworld/Kimi-VL-A3B-Thinking-2506-LLM:latest, ornith:35b-q8_0, ornith:9b-q8_0, gemma4:12b, qwen2.5:1.5b-instruct-q8_0, manutic/nomic-embed-code:latest, nomic-embed-text-v2-moe:latest, qwen3:8b, steelpuddles/hermes-4.3-36B:thinking-tools, hermes3:8b-llama3.1-q8_0, hermes3:70b-llama3.1-q8_0, hermes3:3b-llama3.2-q8_0, nous-hermes2-mixtral:8x7b-dpo-q8_0, laguna-xs.2:q8_0, lfm2.5:8b-a1b-q8_0, lfm2:24b-q8_0, moondream:1.8b-v2-q8_0, firefunction-v2:70b-q8_0, reader-lm:1.5b-q8_0, gemma4:31b-cloud, gemma4:31b, nemotron-3-super:cloud, nemotron-3-super:latest, qwen3-coder:latest, qwen3-coder:480b-cloud, qwen3-embedding:0.6b, qwen3-embedding:4b, qwen3-embedding:8b, qwen3-coder-next:cloud, qwen3.5:397b-cloud, gemma4:latest, gemma4:cloud, gpt-oss:120b-cloud, gpt-oss:20b-cloud, gpt-oss:120b, gpt-oss:20b, deepseek-v4-pro:cloud, deepseek-v4-flash:cloud, llama3.2-vision:latest, llama3.2-vision:11b, qwen3-vl:30b, glm-5.2:cloud, mistral-small:24b, qwen2.5-coder:14b, falcon3:10b, qwen3:14b, llava:13b, qwen2.5-coder:7b, qwen3.6:35b-a3b-mtp-q8_0, qwen3.6:27b-mtp-q8_0, qwen2.5:3b, nemotron:latest, nemotron:70b, nemotron-mini:latest, nemotron-mini:4b, nemotron-3-nano:4b, nemotron-3-nano:latest, nemotron-3-nano:30b, nemotron-cascade-2:latest, nemotron3:33b, mixtral:8x7b, mixtral:8x22b, devstral:latest, codestral:latest, mistral-large:latest, mistral-nemo:latest, bge-large:335m-en-v1.5-fp16, qwen2.5-coder:1.5b, starcoder2:3b, deepseek-r1:14b, deepseek-r1:32b, deepseek-coder-v2:16b, llama3.1:8b, qwen2.5-coder:1.5b-base, nomic-embed-text:latest, qwen2.5-coder:32b-instruct, llama3.3:latest, custom-qwen3:latest, qwen3.6:27b-q8_0, qwen3.6:35b-a3b-q8_0, minimax-m3:cloud, kimi-k2.7-code:cloud, glm4:latest, qwen3-vl:latest, qwen3.6:latest, qwen3-coder-next:latest, gemma4:26b, devstral-small-2:24b, qwen3.6:27b, qwen2.5vl:7b, qwen3-coder:30b, gemma:latest, mistral:latest, command-r7b-arabic:latest, iKhalid/ALLaM:7b, mistral-nemo:12b-instruct-2407-q8_0, qwen3-coder-next:q8_0, llama3-groq-tool-use:latest, codestral:22b, starcoder2:7b, llama3.2:latest, llama3.2:1b
- Tesseract OCR Engine: Ready (WebAssembly)
- Sharp CV Engine: Ready
```

---

### fast_ocr_tesseract

**Duration:** 168ms

**Parameters:**

```json
{
  "image_source": "[synthetic png base64]",
  "language": "eng"
}
```

**Output:**

```
[Tesseract OCR Engine - Language: eng - Confidence: 96%]

HYBRID VISION TEST 123
```

---

### preprocess_and_crop

**Duration:** 6ms

**Parameters:**

```json
{
  "image_source": "[synthetic png base64]",
  "crop": {
    "left": 10,
    "top": 10,
    "width": 200,
    "height": 60
  },
  "grayscale": true,
  "sharpen": false
}
```

**Output:**

```
Image preprocessed successfully. Output Base64 data (length: 3656 chars).
Data URI: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAAA8CAYAAAAjW/WRAAAACXBIWXMAAAsTAAALEwEAmpwYAAAKZ0lEQVR4nO2bBYwVOxSGF3d3...
```

---

### analyze_image

**Duration:** 13155ms

**Parameters:**

```json
{
  "image_source": "[synthetic ui base64]",
  "prompt": "What text and UI elements are visible in this image?",
  "model": "llava:13b (default)"
}
```

**Output:**

```
The image shows a user interface from a website or mobile application. There are several visible components:

1. At the top, there is a navigation bar with what appears to be a back arrow (on the left side) indicating that users can go back to previous pages or sections.
2. Below the navigation bar is a heading in bold text that reads "Hello World." This is likely a placeholder text used during development and testing of the application's functionality.
3. To the right of the heading, there is a button with the label "Submit," suggesting that this is an actionable element where users can submit information or data.
4. The main body of text in the image reads "OCR Test 1 45 625 6." This could be referring to some sort of Optical Character Recognition (OCR) test with a score and possibly related to an application that uses OCR technology for document processing or analysis.
5. The layout includes a form or input area, where users might enter data, although it's not fully visible in the image.
```

---

### find_text_element

**Duration:** 1463ms

**Parameters:**

```json
{
  "image_source": "[synthetic ui base64]",
  "query": "Submit",
  "model": "llava:13b"
}
```

**Output:**

```
The button labeled "Submit" is located at the bottom right of the image. It's a green button with a white outline, and it's centered on the bottom right.
```

---

### compare_images

**Duration:** 8187ms

**Parameters:**

```json
{
  "image_sources": [
    "[synthetic base64]",
    "[synthetic base64]"
  ],
  "prompt": "List all visual differences between these images.",
  "model": "llava:13b"
}
```

**Output:**

```
The image appears to show two different flags or symbols, each with a distinct color scheme and design elements. Here are the differences I can identify:

1. Background Color: The left flag has a solid yellow background while the right flag features a yellow border surrounding a blue center.

2. Shape of Circles: In both designs, there is a circular shape, but the left circle has a green center and the right one has a blue center.

3. Size of Symbols: The blue symbol on the right appears to be larger than its counterpart on the left.

4. Alignment of Elements: In the design on the right, the blue symbol is centered within the yellow border, whereas on the left, the green circle is positioned slightly towards the left side compared to the center alignment of the yellow border on the right.

These are the visual differences that can be observed between the two images.
```

---

## Edge Case Validation Tests

## Summary

- Tools tested: 6
- Successful: 6
- Server: http://localhost:11402
- All images transmitted as Base64 Data URIs (remote host compliant)
