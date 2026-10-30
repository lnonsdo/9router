---
name: 9router-image
description: Generate and edit images via 9Router /v1/images/generations using OpenAI / Gemini / DALL-E / FLUX / Seedream / MiniMax / SDWebUI / ComfyUI / Codex models. Use when the user wants to create, generate, draw, render, or edit an image or picture — text-to-image (txt2img) or image-to-image (img2img, reference-image edit).
---

# 9Router — Image Generation & Editing

Requires `NINEROUTER_URL` (and `NINEROUTER_KEY` if auth enabled). See https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router/SKILL.md for setup.

## Discover

```bash
curl $NINEROUTER_URL/v1/models/image | jq '.data[] | {id, capabilities}'
# Per-model params/options (size enum, quality enum, capabilities like edit)
curl "$NINEROUTER_URL/v1/models/info?id=openai/dall-e-3"
```

## Endpoint

`POST $NINEROUTER_URL/v1/images/generations`

| Field | Required | Notes |
|---|---|---|
| `model` | yes | from `/v1/models/image` |
| `prompt` | yes | image description or edit instruction |
| `image` | no | reference image for img2img/edit — URL or base64 data URI (edit-capable providers only, see quirks) |
| `images` | no | array form of `image` for multi-reference providers |
| `mask_image` | no | inpainting mask (cloudflare-ai inpainting models) |
| `n` | no | count (provider-dependent) |
| `size` | no | `1024x1024`, `1792x1024`, ... |
| `quality` | no | `standard` / `hd` (OpenAI) |
| `response_format` | no | `url` (default) or `b64_json` |

Add query `?response_format=binary` to receive raw image bytes (handy for saving file).

## Examples

Text-to-image, save to file (binary):

```bash
curl -X POST "$NINEROUTER_URL/v1/images/generations?response_format=binary" \
  -H "Authorization: Bearer $NINEROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini/gemini-3-pro-image-preview","prompt":"watercolor mountains at sunrise","size":"1024x1024"}' \
  --output out.png
```

Image-to-image edit (reference image + instruction):

```bash
curl -X POST "$NINEROUTER_URL/v1/images/generations" \
  -H "Authorization: Bearer $NINEROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"ark-ap/doubao-seedream-5.0-pro","prompt":"put a red knitted hat on this dog, keep everything else unchanged","image":"https://example.com/dog.png"}'
```

Multi-reference (providers with `multiImage` capability): send `"images": ["url1", "url2"]`.

JS (URL response):

```js
const r = await fetch(`${process.env.NINEROUTER_URL}/v1/images/generations`, {
  method: "POST",
  headers: { "Authorization": `Bearer ${process.env.NINEROUTER_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gemini/gemini-3-pro-image-preview", prompt: "neon city", size: "1024x1024" }),
});
const { data } = await r.json();
console.log(data[0].url || data[0].b64_json.slice(0, 40));
```

## Response shape

JSON (default `response_format=url`):
```json
{ "created": 1735000000, "data": [{ "url": "https://..." }] }
```

`response_format=b64_json`:
```json
{ "created": 1735000000, "data": [{ "b64_json": "iVBORw0KGgo..." }] }
```

Query `?response_format=binary` returns raw image bytes (Content-Type `image/png` or `image/jpeg`).

## Provider quirks

Common fields above work everywhere. These add/override:

| Provider | Extra/changed fields | Notes |
|---|---|---|
| `openai`, `minimax`, `openrouter`, `recraft`, `vercel-ai-gateway`, `xai`, `sensenova` | `quality`, `style`, `response_format` | Standard OpenAI shape; T2I only — reference image is not forwarded |
| `ark-ap` (Seedream AgentPlan) | `image` (string; array for multi-ref, ≤10 pro / ≤14 flash; URL or base64) | I2I verified end-to-end; `watermark`, `layer_decomposition`, `background` (pro) also pass through |
| `open-design` (od) | — T2I only for now | Gateway catalogs image-input models but drops `image`/`images` on /v1/images/generations (probed 2026-10-31: reference silently ignored); `/v1/images/edits` → 404. Also: upstream Seedream rejects <3.68 MP, so 1024x1024 errors and 2048x2048 is the working default |
| `gemini` (nano-banana) | `image` / `images[0]` (edit) | Sent as `inlineData`; ignores `size`/`n` |
| `antigravity` | `image`, `reference_images[]` (up to 10) | Multi-reference edit |
| `codex` (gpt-image) | `image`, `images[]`, `image_detail`, `output_format`, `background` | SSE stream; **ChatGPT Plus/Pro required** |
| `huggingface` | `image` **required** for edit models (FLUX.1-Kontext, Qwen-Image-Edit) | Errors without a source image |
| `nanobanana` | `image`, `images[]` (edit mode) | `size` → aspect ratio; async polling |
| `fal-ai` | `image` (img2img) | `n` → `num_images`; `size` → ratio; async |
| `stability-ai` | `style` (preset), `output_format` | `size` → `aspect_ratio` |
| `black-forest-labs` (FLUX Kontext) | `image` (ref) | `size` → exact `width`/`height`; async |
| `runwayml` | `image` (ref) | `size` → ratio; async; video models exist |
| `cloudflare-ai` | `image` + `mask_image` | img2img models take `image`; inpainting models take both |
| `sdwebui`, `comfyui` | — | Localhost noAuth (`:7860` / `:8188`) |

Edit capability is discoverable per model: `capabilities` in `/v1/models/image` includes `edit` (accepts `image`) and `mask` (accepts `mask_image`).
