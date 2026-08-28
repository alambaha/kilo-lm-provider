# Kilo Language Model Provider for VS Code

Access all 500+ Kilo Gateway models in GitHub Copilot Chat — Claude Opus, GPT-5, Gemini, DeepSeek, Grok, and more.

## Features

- **500+ models** from Kilo Gateway catalog
- **Custom models** — add any OpenAI-compatible endpoint (Ollama, OpenRouter, vLLM, etc.)
- **Vision Proxy** — text-only models can "see" images via a vision-capable model
- **Thinking controls** — per-model reasoning effort (off/low/medium/high)
- **Thinking blocks** — collapsible reasoning in chat (via LanguageModelThinkingPart)
- **Usage tracking** — real-time cost display in status bar
- **Auto-retry** — exponential backoff for 502/503/429 errors
- **Context overflow retry** — auto-reduces tokens and retries on context-too-long
- **Kilo OAuth** authentication (same as Kilo Code)

## Quick Start

1. Install from [VS Code Marketplace](https://marketplace.visualstudio.com/) (search "Kilo Gateway") or `code --install-extension kilo-lm-provider-0.1.0.vsix`
2. Run `Kilo: Login` from Command Palette (`Ctrl+Shift+P`)
3. Get your API key from [app.kilo.ai](https://app.kilo.ai) → Profile → API Key
4. Open Copilot Chat → model dropdown → **Kilo Gateway** → pick any model

## Commands

| Command | Description |
|---------|-------------|
| `Kilo: Login` | Enter your Kilo API key |
| `Kilo: Logout` | Remove stored API key |
| `Kilo: Set Reasoning Effort` | Toggle thinking depth (off/low/medium/high) |
| `Kilo: Configure Vision Proxy` | Pick which model describes images for text-only models |
| `Kilo: Show Usage` | View session cost and token usage |
| `Kilo: Refresh Models` | Reload model catalog from Kilo Gateway |

## Vision Proxy

Text-only models can't process images. Vision Proxy sends images to a vision-capable model (Claude, GPT-4o, Gemini) and feeds the description to your selected model.

**Setup:** Run `Kilo: Configure Vision Proxy` → pick a vision-capable model from the list.

**How it works:**
1. You drop an image into chat
2. Extension sends image to the vision model
3. Vision model returns a structured description (text extraction + visual context)
4. Description is sent to your selected model as `[Image Description: ...]`

**Settings:**
- `kilo-lm.visionModel` — model ID for image description (auto-detected if empty)
- `kilo-lm.visionPrompt` — custom prompt for image description

## Custom Models

Add any OpenAI-compatible endpoint alongside Kilo Gateway models:

```json
{
  "kilo-lm.customModels": [
    {
      "id": "ollama/llama3.3",
      "name": "Ollama Llama 3.3",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "contextLength": 131072,
      "maxOutputTokens": 32768,
      "supportsTools": true,
      "supportsImages": false,
      "supportsReasoning": false
    }
  ]
}
```

## Reasoning/Thinking

Per-model reasoning effort control:
- **Off** — fastest, no reasoning tokens
- **Low** — minimal thinking for quick tasks
- **Medium** — balanced (default)
- **High** — maximum thinking for complex problems (uses more tokens)

Models that require reasoning (e.g., `kimi-k2-thinking`) are always forced to high.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `kilo-lm.reasoningEffort` | `medium` | Thinking depth (off/low/medium/high) |
| `kilo-lm.visionModel` | *(auto)* | Vision proxy model ID |
| `kilo-lm.visionPrompt` | built-in | Image description prompt |
| `kilo-lm.customModels` | `[]` | Custom OpenAI-compatible models |

## Architecture

```
src/
├── extension.ts      # Activation + commands + status bar
├── auth.ts           # Kilo API key management
├── models.ts         # Model catalog (Kilo Gateway + custom)
├── chat-provider.ts  # LanguageModelChatProvider implementation
├── vision.ts         # Vision Proxy with LRU cache
└── usage.ts          # Token/cost tracking
```

## License

MIT
