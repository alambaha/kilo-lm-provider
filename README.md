# Kilo Language Model Provider for VS Code

A VS Code extension that brings **all Kilo Gateway models** into GitHub Copilot Chat's model picker — Claude Opus, GPT-5, Gemini, DeepSeek, Grok, and 500+ more.

## Features

- **500+ models** from Kilo Gateway in Copilot Chat
- **Kilo OAuth** authentication (same as Kilo Code)
- **Streaming** responses with tool calling support
- **Model capabilities** — tool calling, vision, context window
- **No API key management** — uses your Kilo account

## Installation

```bash
# Build
npm install
npm run build

# Package
npx vsce package

# Install in VS Code
code --install-extension kilo-lm-provider-0.1.0.vsix
```

## Usage

1. Open Copilot Chat in VS Code
2. Click the model dropdown → select **Kilo Gateway**
3. First time: authenticate with Kilo OAuth
4. Pick any model from the Kilo catalog

## Architecture

```
src/
├── extension.ts      # Activation + command registration
├── auth.ts           # Kilo OAuth flow (PKCE)
├── models.ts         # Kilo Gateway model fetching
└── chat-provider.ts  # LanguageModelChatProvider implementation
```

## How It Works

1. Registers as `kilo` vendor via `vscode.lm.registerLanguageModelChatProvider`
2. Fetches model catalog from `https://api.kilo.ai/api/gateway/models`
3. Authenticates via Kilo OAuth (PKCE flow)
4. Routes chat requests through Kilo Gateway's OpenAI-compatible API
5. Streams responses back to Copilot Chat

## Model Access

All models available through Kilo Gateway:
- **Anthropic**: Claude Opus 4.7, Sonnet 4.6, Haiku 4.5
- **OpenAI**: GPT-5.4, GPT-5.4-mini
- **Google**: Gemini 3.1 Pro, Gemini 2.5 Flash
- **xAI**: Grok 4, Grok Code Fast
- **DeepSeek**: DeepSeek V3.2
- **MiniMax**: MiniMax M2.7
- **Moonshot**: Kimi K2.5
- **And 500+ more**

## License

MIT
