# Hybrid Vision MCP Server — Actual Tool Usage Report

**Generated:** 2026-07-23T07:37:17.863Z
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

**Duration:** 7ms

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

**Duration:** 155ms

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

**Duration:** 5ms

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

**Duration:** 6594ms

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
In the image, I can see a form or interface with the following elements:

1. A heading that says "Hello World" at the top center of the image.
2. Below the heading is some text that appears to be part of instructions or a welcome message, but it's not clear enough to read everything it says. It seems to mention something about OCR testing and possibly an ID number (456), but the full context isn't entirely visible.
3. There is a button labeled "Submit" located towards the bottom center of the image, indicating where someone would click to submit their information or test results.
```

---

### find_text_element

**Duration:** 1631ms

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
The "Submit" button is located towards the right side of the image, just below the input field where you would type your name. It has a green rounded square shape with a white checkmark inside it.
```

---

### compare_images

**Duration:** 5084ms

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
The image you've provided is a simplified representation of the flag of Japan, which features a circle in two colors: blue and green. There are no realistic elements or variations in this image as it appears to be a stylized or digital art version of the flag rather than an actual photograph or painting. If there were any visual differences that are not apparent due to the nature of the image, I would need a more detailed or complex comparison to identify them accurately.
```

---

## Edge Case Validation Tests

## Summary

- Tools tested: 6
- Successful: 6
- Server: http://localhost:11402
- All images transmitted as Base64 Data URIs (remote host compliant)
