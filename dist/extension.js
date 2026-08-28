"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode5 = __toESM(require("vscode"));

// src/auth.ts
var vscode2 = __toESM(require("vscode"));
var API_KEY_STORAGE = "kilo-lm.apiKey";
var GATEWAY_BASE = "https://api.kilo.ai/api/gateway";
var KiloAuth = class {
  constructor(context) {
    this.context = context;
    this.loadKey();
  }
  apiKey = null;
  loadKey() {
    this.apiKey = this.context.secrets.get(API_KEY_STORAGE) ?? null;
  }
  async login() {
    const key = await vscode2.window.showInputBox({
      prompt: "Enter your Kilo Gateway API Key",
      placeHolder: "JWT token from app.kilo.ai \u2192 Profile \u2192 API Key",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value) return "API key is required";
        if (value.length < 10) return "API key seems too short";
        return null;
      }
    });
    if (!key) return;
    this.apiKey = key;
    await this.context.secrets.store(API_KEY_STORAGE, key);
    vscode2.window.showInformationMessage("Kilo: API key saved successfully");
  }
  async logout() {
    this.apiKey = null;
    await this.context.secrets.delete(API_KEY_STORAGE);
    vscode2.window.showInformationMessage("Kilo: API key removed");
  }
  async getAccessToken() {
    if (!this.apiKey) {
      const action = await vscode2.window.showWarningMessage(
        "Kilo API key not configured. Please enter your API key.",
        "Enter API Key",
        "Cancel"
      );
      if (action === "Enter API Key") {
        await this.login();
      }
    }
    return this.apiKey;
  }
  isAuthenticated() {
    return this.apiKey !== null;
  }
  async validateKey(key) {
    try {
      const response = await fetch(`${GATEWAY_BASE}/models`, {
        headers: { Authorization: `Bearer ${key}` }
      });
      return response.ok;
    } catch {
      return false;
    }
  }
};

// src/models.ts
var GATEWAY_BASE2 = "https://api.kilo.ai/api/gateway";
var REASONING_MODELS = [
  "opus-4",
  "o1",
  "o3",
  "o4",
  "gpt-5",
  "grok-4",
  "kimi-k2",
  "deepseek-r1",
  "qwen3",
  "gemini-2.5-pro",
  "gemini-3",
  "minimax-m",
  "claude-opus",
  "claude-sonnet"
];
function modelSupportsReasoning(id) {
  const lower = id.toLowerCase();
  return REASONING_MODELS.some((pattern) => lower.includes(pattern));
}
function modelRequiresReasoning(id) {
  const lower = id.toLowerCase();
  return lower.includes("kimi-k2-thinking") || lower.includes("-thinking");
}
var KiloModelProvider = class {
  constructor(auth) {
    this.auth = auth;
    this.loadCustomModels();
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kilo-lm.customModels")) {
        this.loadCustomModels();
      }
    });
  }
  models = [];
  customModels = [];
  lastFetch = 0;
  cacheTtl = 36e5;
  loadCustomModels() {
    const config = vscode.workspace.getConfiguration("kilo-lm");
    this.customModels = config.get("customModels", []);
  }
  getCustomModels() {
    return this.customModels;
  }
  getCustomModelBaseUrl(modelId) {
    const custom = this.customModels.find((m) => m.id === modelId);
    return custom?.baseUrl ?? null;
  }
  isCustomModel(modelId) {
    return this.customModels.some((m) => m.id === modelId);
  }
  getCustomModelApiKey(modelId) {
    const custom = this.customModels.find((m) => m.id === modelId);
    return custom?.apiKey ?? null;
  }
  async refresh() {
    await this.fetchModels(true);
  }
  async getModels() {
    const gatewayModels = await this.getGatewayModels();
    const custom = this.customModels.map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.contextLength,
      maxOutputTokens: m.maxOutputTokens,
      supportsTools: m.supportsTools,
      supportsImages: m.supportsImages,
      supportsReasoning: m.supportsReasoning,
      reasoningRequired: false,
      pricing: m.pricing ?? { prompt: 0, completion: 0 }
    }));
    return [...gatewayModels, ...custom].sort((a, b) => a.name.localeCompare(b.name));
  }
  async getGatewayModels() {
    if (this.models.length > 0 && Date.now() - this.lastFetch < this.cacheTtl) {
      return this.models;
    }
    await this.fetchModels();
    return this.models;
  }
  async fetchModels(force = false) {
    if (!force && this.models.length > 0 && Date.now() - this.lastFetch < this.cacheTtl) {
      return;
    }
    try {
      const token = await this.auth.getAccessToken();
      const headers = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const response = await fetch(`${GATEWAY_BASE2}/models`, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }
      const data = await response.json();
      this.models = data.data.filter((m) => !m.architecture?.output_modalities?.includes("image")).filter((m) => !m.supported_parameters || m.supported_parameters.includes("tools")).map((m) => ({
        id: m.id,
        name: m.name,
        contextLength: m.context_length,
        maxOutputTokens: m.max_completion_tokens ?? Math.min(m.context_length, 32768),
        supportsTools: !m.supported_parameters || m.supported_parameters.includes("tools"),
        supportsImages: m.supported_parameters?.includes("image") ?? false,
        supportsReasoning: modelSupportsReasoning(m.id),
        reasoningRequired: modelRequiresReasoning(m.id),
        pricing: {
          prompt: parseFloat(m.pricing?.prompt ?? "0"),
          completion: parseFloat(m.pricing?.completion ?? "0")
        }
      })).sort((a, b) => a.name.localeCompare(b.name));
      this.lastFetch = Date.now();
    } catch (err) {
      console.error("[Kilo LM] Failed to fetch models:", err);
      if (this.models.length === 0) {
        this.getFallbackModels();
      }
    }
  }
  getFallbackModels() {
    this.models = [
      { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7", contextLength: 2e5, maxOutputTokens: 32768, supportsTools: true, supportsImages: true, supportsReasoning: true, reasoningRequired: false, pricing: { prompt: 15e-6, completion: 75e-6 } },
      { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextLength: 2e5, maxOutputTokens: 32768, supportsTools: true, supportsImages: true, supportsReasoning: true, reasoningRequired: false, pricing: { prompt: 3e-6, completion: 15e-6 } },
      { id: "openai/gpt-5.4", name: "GPT-5.4", contextLength: 128e3, maxOutputTokens: 16384, supportsTools: true, supportsImages: true, supportsReasoning: true, reasoningRequired: false, pricing: { prompt: 5e-6, completion: 2e-5 } },
      { id: "google/gemini-3.1-pro", name: "Gemini 3.1 Pro", contextLength: 1e6, maxOutputTokens: 32768, supportsTools: true, supportsImages: true, supportsReasoning: true, reasoningRequired: false, pricing: { prompt: 2e-6, completion: 1e-5 } }
    ];
    this.lastFetch = Date.now();
  }
};

// src/chat-provider.ts
var vscode4 = __toESM(require("vscode"));

// src/vision.ts
var vscode3 = __toESM(require("vscode"));
var VisionProxy = class _VisionProxy {
  static instance = null;
  cache = /* @__PURE__ */ new Map();
  cacheLimit = 100;
  cacheTtl = 36e5;
  static getInstance() {
    if (!_VisionProxy.instance) {
      _VisionProxy.instance = new _VisionProxy();
    }
    return _VisionProxy.instance;
  }
  async describeImage(imageData, mimeType) {
    const cacheKey = this.hashData(imageData, mimeType);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTtl) {
      console.log("[Kilo LM] Vision cache hit for", mimeType);
      return cached.result;
    }
    console.log("[Kilo LM] Vision proxy: describing image", mimeType, "size:", imageData.length);
    const visionModel = await this.selectVisionModel();
    if (!visionModel) {
      throw new Error("No vision-capable model available. Install Claude, GPT-4o, or run 'Kilo: Configure Vision Proxy'.");
    }
    console.log("[Kilo LM] Using vision model:", visionModel.id);
    const prompt = vscode3.workspace.getConfiguration("kilo-lm").get("visionPrompt", DEFAULT_VISION_PROMPT);
    try {
      const messages = [
        vscode3.LanguageModelChatMessage.User([
          new vscode3.LanguageModelDataPart(imageData, mimeType),
          new vscode3.LanguageModelTextPart(prompt)
        ])
      ];
      const tokenSource = new vscode3.CancellationTokenSource();
      const response = await visionModel.sendRequest(messages, {}, tokenSource.token);
      let description = "";
      for await (const chunk of response.text) {
        description += chunk;
      }
      tokenSource.dispose();
      const result = { description: description.trim(), modelUsed: visionModel.id };
      if (this.cache.size >= this.cacheLimit) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, { result, timestamp: Date.now() });
      return result;
    } catch (err) {
      throw new Error(`Vision proxy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async selectVisionModel() {
    const configured = vscode3.workspace.getConfiguration("kilo-lm").get("visionModel");
    const models = await vscode3.lm.selectChatModels();
    if (configured) {
      const match = models.find((m) => m.id === configured || m.name === configured);
      if (match) return match;
    }
    const visionCapable = models.filter(
      (m) => m.vendor === "copilot" || m.id?.toLowerCase().includes("claude") || m.id?.toLowerCase().includes("gpt-4") || m.id?.toLowerCase().includes("gemini") || m.id?.toLowerCase().includes("grok")
    );
    return visionCapable[0] ?? null;
  }
  async configureVisionProxy() {
    const models = await vscode3.lm.selectChatModels();
    const currentId = vscode3.workspace.getConfiguration("kilo-lm").get("visionModel");
    const items = [
      { label: "$(close) None", description: "Disable vision proxy", detail: "Images will be ignored for text-only models" },
      { label: "$(edit) Customize prompt", description: "Edit the image description prompt" },
      { label: "", kind: vscode3.QuickPickItemKind.Separator }
    ];
    const modelItems = models.map((m) => ({
      label: m.id === currentId ? "$(check) " + m.id : m.id,
      description: m.vendor ?? "",
      detail: m.id === currentId ? "Currently selected" : void 0
    }));
    items.push(...modelItems);
    const picked = await vscode3.window.showQuickPick(items, {
      placeHolder: "Select vision proxy model (images will be described by this model)",
      matchOnDescription: true
    });
    if (!picked) return;
    if (picked.label === "$(close) None") {
      await vscode3.workspace.getConfiguration("kilo-lm").update("visionModel", "", vscode3.ConfigurationTarget.Global);
      vscode3.window.showInformationMessage("Kilo: Vision proxy disabled");
    } else if (picked.label === "$(edit) Customize prompt") {
      await this.configureVisionPrompt();
    } else {
      const modelId = picked.label.replace("$(check) ", "");
      await vscode3.workspace.getConfiguration("kilo-lm").update("visionModel", modelId, vscode3.ConfigurationTarget.Global);
      vscode3.window.showInformationMessage(`Kilo: Vision proxy set to "${modelId}"`);
    }
  }
  async configureVisionPrompt() {
    const current = vscode3.workspace.getConfiguration("kilo-lm").get("visionPrompt", DEFAULT_VISION_PROMPT);
    const result = await vscode3.window.showInputBox({
      prompt: "Vision proxy prompt",
      value: current,
      ignoreFocusOut: true
    });
    if (result !== void 0) {
      await vscode3.workspace.getConfiguration("kilo-lm").update("visionPrompt", result, vscode3.ConfigurationTarget.Global);
    }
  }
  hasVisionCapability(modelId) {
    const visionPatterns = ["claude", "gpt-4", "gemini", "grok"];
    return visionPatterns.some((p) => modelId.toLowerCase().includes(p));
  }
  clearCache() {
    this.cache.clear();
  }
  hashData(data, mimeType) {
    let hash = 0;
    const str = mimeType + data.length.toString();
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i) | 0;
    }
    return hash.toString(36);
  }
};
var DEFAULT_VISION_PROMPT = `Text extraction is mandatory. Visual description required unless the image is tightly cropped text-only.

TASK 1 \u2014 TEXT EXTRACTION (always):
1. Transcribe every detectable character verbatim \u2014 all text, symbols, and glyphs of any kind, in any location. Never correct, alter, summarize, paraphrase, or truncate the source.
2. Preserve formatting: monospaced \u2192 code block, proportional \u2192 plain text, tabular \u2192 Markdown table.
3. Annotate spatial position with [Region: name] headers for multi-region images.
4. Uncertainty markers: [?] = uncertain char, [unclear] = uncertain span, [unreadable] = illegible.

TASK 2 \u2014 VISUAL DESCRIPTION (unless tightly cropped text-only):
1. Describe all non-text visual content: window chrome, UI state, colors, diagrams.
2. Diagrams: describe structure \u2014 what labels represent, how elements connect.

OUTPUT FORMAT:
--- Extracted Text ---
[transcription]
--- Visual Context ---
[description]

SPECIAL CASES:
- Handwriting: best-effort; prepend "(Handwriting \u2014 lower confidence.)"
- No text: output "No text detected."`;

// src/usage.ts
var UsageTracker = class _UsageTracker {
  static instance = null;
  entries = [];
  sessionStart = Date.now();
  _onUsageChanged = /* @__PURE__ */ new Map();
  static getInstance() {
    if (!_UsageTracker.instance) {
      _UsageTracker.instance = new _UsageTracker();
    }
    return _UsageTracker.instance;
  }
  record(model, promptTokens, completionTokens, pricing) {
    const cost = (promptTokens * pricing.prompt + completionTokens * pricing.completion) / 1e6;
    this.entries.push({
      timestamp: Date.now(),
      model,
      promptTokens,
      completionTokens,
      cost
    });
    this.notifyListeners();
  }
  getSessionSummary() {
    const sessionEntries = this.entries.filter((e) => e.timestamp >= this.sessionStart);
    return {
      sessionTokens: sessionEntries.reduce((sum, e) => sum + e.promptTokens + e.completionTokens, 0),
      sessionCost: sessionEntries.reduce((sum, e) => sum + e.cost, 0),
      totalTokens: this.entries.reduce((sum, e) => sum + e.promptTokens + e.completionTokens, 0),
      totalCost: this.entries.reduce((sum, e) => sum + e.cost, 0),
      requestCount: sessionEntries.length
    };
  }
  onUsageChanged(key, callback) {
    this._onUsageChanged.set(key, callback);
  }
  removeListener(key) {
    this._onUsageChanged.delete(key);
  }
  notifyListeners() {
    for (const cb of this._onUsageChanged.values()) {
      cb();
    }
  }
  resetSession() {
    this.sessionStart = Date.now();
    this.notifyListeners();
  }
};

// src/chat-provider.ts
var GATEWAY_BASE3 = "https://api.kilo.ai/api/gateway";
var KiloChatProvider = class {
  constructor(auth, modelProvider) {
    this.auth = auth;
    this.modelProvider = modelProvider;
    this.loadConfig();
    vscode4.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kilo-lm.reasoning")) {
        this.loadConfig();
      }
    });
  }
  reasoningEffort = "medium";
  visionProxy = VisionProxy.getInstance();
  usageTracker = UsageTracker.getInstance();
  loadConfig() {
    const config = vscode4.workspace.getConfiguration("kilo-lm");
    this.reasoningEffort = config.get("reasoningEffort", "medium");
  }
  async provideLanguageModelChatInformation(options, token) {
    try {
      const models = await this.modelProvider.getModels();
      return models.map((m) => ({
        id: m.id,
        name: m.name,
        family: m.id.split("/")[0] ?? "kilo",
        version: "1.0.0",
        maxInputTokens: m.contextLength - m.maxOutputTokens,
        maxOutputTokens: m.maxOutputTokens,
        capabilities: {
          imageInput: m.supportsImages || this.visionProxy.hasVisionCapability(m.id),
          toolCalling: m.supportsTools
        }
      }));
    } catch (err) {
      console.error("[Kilo LM] Failed to provide model info:", err);
      return [];
    }
  }
  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    const isCustom = this.modelProvider.isCustomModel(model.id);
    let token_ = null;
    let baseUrl = GATEWAY_BASE3;
    if (isCustom) {
      const customKey = this.modelProvider.getCustomModelApiKey(model.id);
      const customUrl = this.modelProvider.getCustomModelBaseUrl(model.id);
      if (!customKey) {
        throw new Error("Custom model requires an API key. Configure it in settings.");
      }
      token_ = customKey;
      baseUrl = customUrl;
    } else {
      token_ = await this.auth.getAccessToken();
    }
    if (!token_) {
      throw new Error("Not authenticated. Run 'Kilo: Login' first.");
    }
    const gatewayMessages = await this.convertMessages(messages, model.id, progress, token);
    const tools = options.tools ? this.convertTools(options.tools) : void 0;
    const fullModel = (await this.modelProvider.getModels()).find((m) => m.id === model.id);
    const reasoning = this.buildReasoning(fullModel);
    const request = {
      model: model.id,
      messages: gatewayMessages,
      stream: true,
      tools
    };
    if (reasoning) {
      request.reasoning = reasoning;
    }
    const maxRetries = 3;
    let lastError = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (token.isCancellationRequested) return;
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token_}`
          },
          body: JSON.stringify(request)
        });
        if (response.ok) {
          if (!response.body) {
            throw new Error("No response body");
          }
          await this.streamResponse(response.body, progress, token, fullModel);
          return;
        }
        const errorText = await response.text();
        const isRetryable = this.isRetryableStatus(response.status);
        const isContextOverflow = this.isContextOverflow(response.status, errorText);
        if (isContextOverflow && attempt < maxRetries - 1) {
          const delay2 = this.getRetryDelay(attempt, 429);
          progress.report(new vscode4.LanguageModelTextPart(`
[Context overflow, reducing and retrying...]
`));
          await this.sleep(delay2);
          request.max_tokens = Math.floor((request.max_tokens ?? 32768) * 0.75);
          await this.modelProvider.refresh();
          continue;
        }
        if (!isRetryable || attempt === maxRetries - 1) {
          throw new Error(`Kilo Gateway error (${response.status}): ${errorText}`);
        }
        lastError = new Error(`Kilo Gateway error (${response.status}): ${errorText}`);
        const delay = this.getRetryDelay(attempt, response.status);
        progress.report(new vscode4.LanguageModelTextPart(`
[Model unavailable, retrying in ${delay / 1e3}s...]
`));
        await this.sleep(delay);
        if (response.status === 502 || response.status === 503) {
          await this.modelProvider.refresh();
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("Not authenticated")) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries - 1) {
          const delay = this.getRetryDelay(attempt, 503);
          await this.sleep(delay);
        }
      }
    }
    throw lastError ?? new Error("Request failed after retries");
  }
  async provideTokenCount(text, token) {
    return Math.ceil(text.length / 4);
  }
  async convertMessages(messages, modelId, progress, cancelToken) {
    const result = [];
    const supportsNativeVision = this.visionProxy.hasVisionCapability(modelId);
    for (const msg of messages) {
      if (cancelToken.isCancellationRequested) break;
      const role = msg.role;
      const rawContent = msg.content;
      let content = "";
      if (typeof rawContent === "string") {
        content = rawContent;
      } else if (Array.isArray(rawContent)) {
        const textParts = [];
        for (const part of rawContent) {
          if (part instanceof vscode4.LanguageModelTextPart) {
            textParts.push(part.value);
          } else if (typeof part === "string") {
            textParts.push(part);
          } else if (part && typeof part === "object") {
            if ("value" in part) {
              textParts.push(part.value);
            } else if ("mimeType" in part && !supportsNativeVision) {
              try {
                const data = part.data || part;
                console.log("[Kilo LM] Processing image part, mimeType:", part.mimeType, "data type:", typeof data, "is Uint8Array:", data instanceof Uint8Array);
                const result2 = await this.visionProxy.describeImage(data, part.mimeType || "image/png");
                textParts.push(`[Image description: ${result2.description}]`);
              } catch (err) {
                console.error("[Kilo LM] Vision proxy error:", err);
                textParts.push(`[Image: could not be processed - ${err instanceof Error ? err.message : String(err)}]`);
              }
            }
          }
        }
        content = textParts.join("\n");
      }
      if (role === vscode4.LanguageModelChatMessageRole.User) {
        result.push({ role: "user", content });
      } else if (role === vscode4.LanguageModelChatMessageRole.Assistant) {
        result.push({ role: "assistant", content });
      }
    }
    return result;
  }
  isRetryableStatus(status) {
    return status === 429 || status === 502 || status === 503 || status === 504 || status === 500;
  }
  isContextOverflow(status, errorText) {
    if (status !== 400 && status !== 429) return false;
    const lower = errorText.toLowerCase();
    return lower.includes("context") || lower.includes("too long") || lower.includes("maximum context") || lower.includes("token limit") || lower.includes("max_tokens");
  }
  getRetryDelay(attempt, status) {
    if (status === 429) {
      return Math.min(5e3 * Math.pow(2, attempt), 3e4);
    }
    return Math.min(1e3 * Math.pow(2, attempt), 1e4);
  }
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  async streamResponse(body, progress, token, model) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let thinkingContent = "";
    let thinkingPart = null;
    try {
      while (true) {
        if (token.isCancellationRequested) {
          await reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            if (thinkingPart) {
              progress.report(thinkingPart);
            }
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.reasoning) {
              thinkingContent += delta.reasoning;
              try {
                thinkingPart = new vscode4.LanguageModelThinkingPart(delta.reasoning);
              } catch {
                progress.report(new vscode4.LanguageModelTextPart(`[thinking] ${delta.reasoning}`));
              }
            }
            if (delta?.content) {
              if (thinkingPart && thinkingContent) {
                progress.report(thinkingPart);
                thinkingContent = "";
                thinkingPart = null;
              }
              progress.report(new vscode4.LanguageModelTextPart(delta.content));
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name) {
                  progress.report(
                    new vscode4.LanguageModelToolCallPart(
                      tc.function.name,
                      tc.id ?? "",
                      tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
                    )
                  );
                }
              }
            }
            if (parsed.usage && model) {
              this.usageTracker.record(
                model.id,
                parsed.usage.prompt_tokens ?? 0,
                parsed.usage.completion_tokens ?? 0,
                model.pricing
              );
            }
          } catch {
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  buildReasoning(model) {
    if (!model) return null;
    if (model.reasoningRequired) {
      return { enabled: true, effort: "high" };
    }
    if (!model.supportsReasoning) return null;
    switch (this.reasoningEffort) {
      case "off":
        return null;
      case "low":
        return { enabled: true, effort: "low" };
      case "medium":
        return { enabled: true, effort: "medium" };
      case "high":
        return { enabled: true, effort: "high", budget_tokens: 32e3 };
    }
  }
  convertTools(tools) {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: {}
      }
    }));
  }
};

// src/extension.ts
function activate(context) {
  console.log("[Kilo LM] Extension activating...");
  try {
    const auth = new KiloAuth(context);
    const modelProvider = new KiloModelProvider(auth);
    const chatProvider = new KiloChatProvider(auth, modelProvider);
    const usageTracker = UsageTracker.getInstance();
    const provider = vscode5.lm.registerLanguageModelChatProvider("kilo", chatProvider);
    context.subscriptions.push(provider);
    console.log("[Kilo LM] Language model provider registered");
    const statusBar = vscode5.window.createStatusBarItem(vscode5.StatusBarAlignment.Right, 100);
    statusBar.text = "$(brain) Kilo";
    statusBar.tooltip = "Kilo Gateway \u2014 Click for usage info";
    statusBar.command = "kilo-lm.showUsage";
    statusBar.show();
    context.subscriptions.push(statusBar);
    const updateStatusBar = () => {
      const summary = usageTracker.getSessionSummary();
      if (summary.requestCount > 0) {
        statusBar.text = "$(brain) Kilo: $" + summary.sessionCost.toFixed(3);
        statusBar.tooltip = `Kilo Gateway Usage
Session: $${summary.sessionCost.toFixed(4)} (${summary.sessionTokens.toLocaleString()} tokens)
Requests: ${summary.requestCount}`;
      } else {
        statusBar.text = "$(brain) Kilo";
        statusBar.tooltip = "Kilo Gateway \u2014 Click for usage info";
      }
    };
    usageTracker.onUsageChanged("statusbar", updateStatusBar);
    context.subscriptions.push(
      vscode5.commands.registerCommand("kilo-lm.testVisionProxy", async () => {
        try {
          const models = await vscode5.lm.selectChatModels();
          const visionModels = models.filter(
            (m) => m.vendor === "copilot" || m.id?.toLowerCase().includes("claude") || m.id?.toLowerCase().includes("gpt-4") || m.id?.toLowerCase().includes("gemini") || m.id?.toLowerCase().includes("grok")
          );
          if (visionModels.length === 0) {
            vscode5.window.showWarningMessage("No vision-capable models found. Install Claude, GPT-4o, or Gemini.");
            return;
          }
          vscode5.window.showInformationMessage(
            `Found ${visionModels.length} vision model(s): ${visionModels.map((m) => m.id).join(", ")}`
          );
        } catch (err) {
          vscode5.window.showErrorMessage(`Vision test failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
    );
    context.subscriptions.push(
      vscode5.commands.registerCommand("kilo-lm.login", async () => {
        await auth.login();
      })
    );
    context.subscriptions.push(
      vscode5.commands.registerCommand("kilo-lm.logout", async () => {
        await auth.logout();
      })
    );
    context.subscriptions.push(
      vscode5.commands.registerCommand("kilo-lm.refreshModels", async () => {
        await modelProvider.refresh();
        vscode5.window.showInformationMessage("Kilo: Models refreshed");
      })
    );
    context.subscriptions.push(
      vscode5.commands.registerCommand("kilo-lm.setReasoningEffort", async () => {
        const current = vscode5.workspace.getConfiguration("kilo-lm").get("reasoningEffort", "medium");
        const result = await vscode5.window.showQuickPick(
          [
            { label: "$(zap) Off", description: "No reasoning \u2014 fastest", value: "off" },
            { label: "$(dash) Low", description: "Minimal thinking", value: "low" },
            { label: "$(circle-large-outline) Medium", description: "Balanced (default)", value: "medium" },
            { label: "$(flame) High", description: "Maximum thinking (more tokens)", value: "high" }
          ],
          { placeHolder: `Reasoning Effort: ${current}` }
        );
        if (result) {
          await vscode5.workspace.getConfiguration("kilo-lm").update("reasoningEffort", result.value, vscode5.ConfigurationTarget.Global);
          vscode5.window.showInformationMessage(`Kilo: Reasoning effort set to "${result.value}"`);
        }
      })
    );
    context.subscriptions.push(
      vscode5.commands.registerCommand("kilo-lm.showUsage", async () => {
        const summary = usageTracker.getSessionSummary();
        const action = await vscode5.window.showInformationMessage(
          `Kilo Gateway Usage
Session cost: $${summary.sessionCost.toFixed(4)}
Session tokens: ${summary.sessionTokens.toLocaleString()}
Requests: ${summary.requestCount}
Total cost: $${summary.totalCost.toFixed(4)}`,
          "Reset Session",
          "Refresh Models"
        );
        if (action === "Reset Session") {
          usageTracker.resetSession();
          vscode5.window.showInformationMessage("Kilo: Session usage reset");
        } else if (action === "Refresh Models") {
          await modelProvider.refresh();
          vscode5.window.showInformationMessage("Kilo: Models refreshed");
        }
      })
    );
    const hasShownWelcome = context.globalState.get("kilo-lm.welcomeShown");
    if (!hasShownWelcome) {
      vscode5.window.showInformationMessage(
        "Kilo Gateway is ready! Get your API key from app.kilo.ai \u2192 Profile \u2192 API Key.",
        "Enter API Key",
        "Later"
      ).then((action) => {
        if (action === "Enter API Key") {
          vscode5.commands.executeCommand("kilo-lm.login");
        }
      });
      context.globalState.update("kilo-lm.welcomeShown", true);
    }
  } catch (err) {
    console.error("[Kilo LM] Activation error:", err);
    throw err;
  }
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
