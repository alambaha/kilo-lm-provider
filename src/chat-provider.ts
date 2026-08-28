import * as vscode from "vscode"
import { KiloAuth } from "./auth"
import { KiloModelProvider, KiloModel } from "./models"
import { VisionProxy } from "./vision"
import { UsageTracker } from "./usage"

const GATEWAY_BASE = "https://api.kilo.ai/api/gateway"

interface GatewayMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface GatewayRequest {
  model: string
  messages: GatewayMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  tools?: GatewayTool[]
  reasoning_effort?: string
  thinking?: Record<string, unknown>
  enable_thinking?: boolean
  thinking_budget?: number
}

interface GatewayTool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface RequestLog {
  timestamp: number
  model: string
  status: "success" | "error" | "retry"
  promptTokens: number
  completionTokens: number
  error?: string
  duration: number
}

export class KiloChatProvider implements vscode.LanguageModelChatProvider {
  readonly visionProxy = VisionProxy.getInstance()
  private usageTracker = UsageTracker.getInstance()
  private requestLog: RequestLog[] = []
  private maxLogSize = 100
  private _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event

  constructor(
    private auth: KiloAuth,
    private modelProvider: KiloModelProvider,
  ) {
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kilo-lm.temperature") || e.affectsConfiguration("kilo-lm.maxTokens")) {
        // config changes picked up at request time
      }
    })
  }

  refreshModelPicker(): void {
    this._onDidChange.fire()
  }

  getRequestLog(): RequestLog[] {
    return [...this.requestLog]
  }

  clearRequestLog(): void {
    this.requestLog = []
  }

  async provideLanguageModelChatInformation(options: { silent: boolean }, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
    try {
      const models = await this.modelProvider.getModels()
      console.log("[Kilo LM] Providing model info for", models.length, "models")
      return models.map((m) => {
        const info: any = {
          id: m.id,
          name: m.name,
          family: m.id.split("/")[0] ?? "kilo",
          version: "1.0.0",
          maxInputTokens: m.contextLength - m.maxOutputTokens,
          maxOutputTokens: m.maxOutputTokens,
          capabilities: {
            imageInput: m.supportsImages || this.visionProxy.hasVisionCapability(m.id),
            toolCalling: m.supportsTools,
          },
        }

        if (m.supportsReasoning && m.reasoningVariants.length > 0) {
          const effortLevels = m.reasoningVariants.map((v) => v.effort)
          info.configurationSchema = {
            properties: {
              reasoningEffort: {
                type: "string",
                title: "Thinking Effort",
                enum: effortLevels,
                enumItemLabels: effortLevels.map((l: string) => l.charAt(0).toUpperCase() + l.slice(1)),
                default: effortLevels[0],
                group: "navigation",
              },
            },
          }
          console.log("[Kilo LM] Model", m.id, "variants:", effortLevels)
        }

        return info
      })
    } catch (err) {
      console.error("[Kilo LM] Failed to provide model info:", err)
      return []
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProviderLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const startTime = Date.now()
    const isCustom = this.modelProvider.isCustomModel(model.id)
    let token_: string | null = null
    let baseUrl = GATEWAY_BASE

    if (isCustom) {
      const customKey = this.modelProvider.getCustomModelApiKey(model.id)
      const customUrl = this.modelProvider.getCustomModelBaseUrl(model.id)
      if (!customKey) {
        throw new Error("Custom model requires an API key. Configure it in settings.")
      }
      token_ = customKey
      baseUrl = customUrl
    } else {
      token_ = await this.auth.getAccessToken()
    }

    if (!token_) {
      throw new Error("Not authenticated. Run 'Kilo: Login' first.")
    }

    const gatewayMessages = await this.convertMessages(messages, model.id, progress, token)
    const tools = options.tools ? this.convertTools(options.tools) : undefined
    const fullModel = (await this.modelProvider.getModels()).find((m) => m.id === model.id)
    const config = vscode.workspace.getConfiguration("kilo-lm")
    const temperature = config.get<number>("temperature", 0.2)
    const maxTokensOverride = config.get<number>("maxTokens", 0)
    const modelConfig = (options as any).modelConfiguration ?? {}

    const request: GatewayRequest = {
      model: model.id,
      messages: gatewayMessages,
      stream: true,
      temperature: temperature > 0 ? temperature : undefined,
      max_tokens: maxTokensOverride > 0 ? maxTokensOverride : undefined,
      tools,
    }

    this.applyReasoning(request, fullModel, modelConfig)

    const maxRetries = 3
    let lastError: Error | null = null

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (token.isCancellationRequested) return

      try {
        const response = await this.fetchWithTimeout(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token_}`,
          },
          body: JSON.stringify(request),
        })

        if (response.ok) {
          if (!response.body) {
            throw new Error("No response body")
          }
          await this.streamResponse(response.body, progress, token, fullModel)
          this.logRequest(model.id, "success", 0, 0, Date.now() - startTime)
          return
        }

        const errorText = await response.text()
        const isRetryable = this.isRetryableStatus(response.status)
        const isContextOverflow = this.isContextOverflow(response.status, errorText)

        if (isContextOverflow && attempt < maxRetries - 1) {
          const delay = this.getRetryDelay(attempt, 429)
          progress.report(new vscode.LanguageModelTextPart(`\n[Context overflow, reducing output and retrying...]\n`))
          await this.sleep(delay)
          request.max_tokens = Math.floor((request.max_tokens ?? 32768) * 0.75)
          await this.modelProvider.refresh()
          this.logRequest(model.id, "retry", 0, 0, Date.now() - startTime, "context_overflow")
          continue
        }

        if (!isRetryable || attempt === maxRetries - 1) {
          this.logRequest(model.id, "error", 0, 0, Date.now() - startTime, errorText)
          throw new Error(`Kilo Gateway error (${response.status}): ${errorText}`)
        }

        lastError = new Error(`Kilo Gateway error (${response.status}): ${errorText}`)
        const delay = this.getRetryDelay(attempt, response.status)
        progress.report(new vscode.LanguageModelTextPart(`\n[Model unavailable, retrying in ${delay / 1000}s...]\n`))
        await this.sleep(delay)
        this.logRequest(model.id, "retry", 0, 0, Date.now() - startTime, `status_${response.status}`)

        if (response.status === 502 || response.status === 503) {
          await this.modelProvider.refresh()
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("Not authenticated")) {
          throw err
        }
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt < maxRetries - 1) {
          const delay = this.getRetryDelay(attempt, 503)
          await this.sleep(delay)
          this.logRequest(model.id, "retry", 0, 0, Date.now() - startTime, lastError.message)
        }
      }
    }

    this.logRequest(model.id, "error", 0, 0, Date.now() - startTime, lastError?.message)
    throw lastError ?? new Error("Request failed after retries")
  }

  async provideTokenCount(text: string, token: vscode.CancellationToken): Promise<number> {
    return Math.ceil(text.length / 4)
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const config = vscode.workspace.getConfiguration("kilo-lm")
    const timeoutMs = config.get<number>("requestTimeout", 60000)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
  }

  private logRequest(model: string, status: "success" | "error" | "retry", promptTokens: number, completionTokens: number, duration: number, error?: string): void {
    this.requestLog.push({
      timestamp: Date.now(),
      model,
      status,
      promptTokens,
      completionTokens,
      duration,
      error,
    })
    if (this.requestLog.length > this.maxLogSize) {
      this.requestLog.shift()
    }
  }

  private async convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    modelId: string,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    cancelToken: vscode.CancellationToken,
  ): Promise<GatewayMessage[]> {
    const result: GatewayMessage[] = []
    const supportsNativeVision = this.visionProxy.hasVisionCapability(modelId)

    for (const msg of messages) {
      if (cancelToken.isCancellationRequested) break

      const role = (msg as any).role
      const rawContent = (msg as any).content
      let content = ""

      if (typeof rawContent === "string") {
        content = rawContent
      } else if (Array.isArray(rawContent)) {
        const textParts: string[] = []
        for (const part of rawContent) {
          if (part instanceof vscode.LanguageModelTextPart) {
            textParts.push(part.value)
          } else if (typeof part === "string") {
            textParts.push(part)
          } else if (part && typeof part === "object") {
            if ("value" in part) {
              textParts.push((part as any).value)
            } else if ("mimeType" in part && !supportsNativeVision) {
              try {
                const data = (part as any).data || part
                const result = await this.visionProxy.describeImage(data, (part as any).mimeType || "image/png")
                textParts.push(`[Image description: ${result.description}]`)
              } catch (err) {
                console.error("[Kilo LM] Vision proxy error:", err)
                textParts.push(`[Image: could not be processed - ${err instanceof Error ? err.message : String(err)}]`)
              }
            }
          }
        }
        content = textParts.join("\n")
      }

      if (role === vscode.LanguageModelChatMessageRole.User) {
        result.push({ role: "user", content })
      } else if (role === vscode.LanguageModelChatMessageRole.Assistant) {
        result.push({ role: "assistant", content })
      }
    }

    return result
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || status === 502 || status === 503 || status === 504 || status === 500
  }

  private isContextOverflow(status: number, errorText: string): boolean {
    if (status !== 400 && status !== 429) return false
    const lower = errorText.toLowerCase()
    return (
      lower.includes("context") ||
      lower.includes("too long") ||
      lower.includes("maximum context") ||
      lower.includes("token limit") ||
      lower.includes("max_tokens")
    )
  }

  private getRetryDelay(attempt: number, status: number): number {
    if (status === 429) {
      return Math.min(5000 * Math.pow(2, attempt), 30000)
    }
    return Math.min(1000 * Math.pow(2, attempt), 10000)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async streamResponse(
    body: ReadableStream<Uint8Array>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    model?: KiloModel,
  ): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let thinkingContent = ""
    let thinkingPart: any = null
    let promptTokens = 0
    let completionTokens = 0

    try {
      while (true) {
        if (token.isCancellationRequested) {
          await reader.cancel()
          return
        }

        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith("data: ")) continue
          const data = trimmed.slice(6)
          if (data === "[DONE]") {
            if (thinkingPart) {
              progress.report(thinkingPart)
            }
            if (model && promptTokens > 0) {
              this.usageTracker.record(model.id, promptTokens, completionTokens, model.pricing)
            }
            return
          }

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta

            if (delta?.reasoning) {
              thinkingContent += delta.reasoning
              try {
                thinkingPart = new (vscode as any).LanguageModelThinkingPart(delta.reasoning)
              } catch {
                progress.report(new vscode.LanguageModelTextPart(`[thinking] ${delta.reasoning}`))
              }
            }

            if (delta?.content) {
              if (thinkingPart && thinkingContent) {
                progress.report(thinkingPart)
                thinkingContent = ""
                thinkingPart = null
              }
              progress.report(new vscode.LanguageModelTextPart(delta.content))
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name) {
                  progress.report(
                    new vscode.LanguageModelToolCallPart(
                      tc.function.name,
                      tc.id ?? "",
                      tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
                    ),
                  )
                }
              }
            }

            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens ?? promptTokens
              completionTokens = parsed.usage.completion_tokens ?? completionTokens
            }
          } catch {
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private applyReasoning(request: GatewayRequest, model: KiloModel | undefined, modelConfig: Record<string, unknown>): void {
    if (!model) return

    if (model.reasoningRequired && model.reasoningVariants.length > 0) {
      const variant = model.reasoningVariants[0]
      this.sendReasoningParam(request, variant)
      return
    }

    if (!model.supportsReasoning || model.reasoningVariants.length === 0) return

    const effort = (modelConfig.reasoningEffort as string) ?? model.reasoningVariants[0].effort
    const variant = model.reasoningVariants.find((v) => v.effort === effort) ?? model.reasoningVariants[0]
    if (!variant.enabled && variant.effort === "none") return

    this.sendReasoningParam(request, variant)
  }

  private sendReasoningParam(request: GatewayRequest, variant: { key: string; effort: string; enabled: boolean }): void {
    const modelId = request.model.toLowerCase()

    if (modelId.includes("minimax")) {
      request.thinking = { type: variant.enabled ? "adaptive" : "disabled" }
    } else if (modelId.includes("deepseek")) {
      request.reasoning_effort = variant.effort
    } else if (modelId.includes("qwen")) {
      request.enable_thinking = variant.enabled
      if (variant.enabled && variant.effort !== "none") {
        const budgets: Record<string, number> = { minimal: 4096, low: 8192, medium: 16384, high: 32768, xhigh: 65536 }
        request.thinking_budget = budgets[variant.effort] ?? 16384
      }
    } else if (modelId.includes("glm") || modelId.includes("kimi")) {
      request.enable_thinking = variant.enabled
    } else if (modelId.includes("claude")) {
      const budgets: Record<string, number> = { low: 4096, medium: 16384, high: 32768, xhigh: 65536 }
      request.thinking = { type: "enabled", budget_tokens: budgets[variant.effort] ?? 16384 }
    } else {
      request.reasoning_effort = variant.effort
    }
  }

  private convertTools(tools: readonly vscode.LanguageModelChatTool[]): GatewayTool[] {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: {},
      },
    }))
  }
}
