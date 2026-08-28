import * as vscode from "vscode"
import { KiloAuth } from "./auth"
import { KiloModelProvider, KiloModel, ReasoningEffort } from "./models"
import { VisionProxy } from "./vision"
import { UsageTracker } from "./usage"

const GATEWAY_BASE = "https://api.kilo.ai/api/gateway"

interface GatewayMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface GatewayReasoning {
  enabled: boolean
  effort?: "low" | "medium" | "high"
  budget_tokens?: number
}

interface GatewayRequest {
  model: string
  messages: GatewayMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  tools?: GatewayTool[]
  reasoning?: GatewayReasoning
}

interface GatewayTool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export class KiloChatProvider implements vscode.LanguageModelChatProvider {
  private reasoningEffort: ReasoningEffort = "medium"
  private visionProxy = VisionProxy.getInstance()
  private usageTracker = UsageTracker.getInstance()

  constructor(
    private auth: KiloAuth,
    private modelProvider: KiloModelProvider,
  ) {
    this.loadConfig()
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kilo-lm.reasoning")) {
        this.loadConfig()
      }
    })
  }

  private loadConfig(): void {
    const config = vscode.workspace.getConfiguration("kilo-lm")
    this.reasoningEffort = config.get<ReasoningEffort>("reasoningEffort", "medium")
  }

  async provideLanguageModelChatInformation(options: { silent: boolean }, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
    try {
      const models = await this.modelProvider.getModels()
      return models.map((m) => ({
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
      }))
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
    const token_ = await this.auth.getAccessToken()
    if (!token_) {
      throw new Error("Not authenticated. Run 'Kilo: Login' first.")
    }

    const gatewayMessages = await this.convertMessages(messages, model.id, progress, token)
    const tools = options.tools ? this.convertTools(options.tools) : undefined
    const fullModel = (await this.modelProvider.getModels()).find((m) => m.id === model.id)
    const reasoning = this.buildReasoning(fullModel)

    const request: GatewayRequest = {
      model: model.id,
      messages: gatewayMessages,
      stream: true,
      tools,
    }

    if (reasoning) {
      request.reasoning = reasoning
    }

    const maxRetries = 3
    let lastError: Error | null = null

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (token.isCancellationRequested) return

      try {
        const response = await fetch(`${GATEWAY_BASE}/chat/completions`, {
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
          return
        }

        const errorText = await response.text()
        const isRetryable = this.isRetryableStatus(response.status)
        const isContextOverflow = this.isContextOverflow(response.status, errorText)

        if (isContextOverflow && attempt < maxRetries - 1) {
          const delay = this.getRetryDelay(attempt, 429)
          progress.report(new vscode.LanguageModelTextPart(`\n[Context overflow, reducing and retrying...]\n`))
          await this.sleep(delay)
          request.max_tokens = Math.floor((request.max_tokens ?? 32768) * 0.75)
          await this.modelProvider.refresh()
          continue
        }

        if (!isRetryable || attempt === maxRetries - 1) {
          throw new Error(`Kilo Gateway error (${response.status}): ${errorText}`)
        }

        lastError = new Error(`Kilo Gateway error (${response.status}): ${errorText}`)
        const delay = this.getRetryDelay(attempt, response.status)
        progress.report(new vscode.LanguageModelTextPart(`\n[Model unavailable, retrying in ${delay / 1000}s...]\n`))
        await this.sleep(delay)

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
        }
      }
    }

    throw lastError ?? new Error("Request failed after retries")
  }

  async provideTokenCount(text: string, token: vscode.CancellationToken): Promise<number> {
    return Math.ceil(text.length / 4)
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
              } catch {
                textParts.push("[Image: could not be processed]")
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

            if (parsed.usage && model) {
              this.usageTracker.record(
                model.id,
                parsed.usage.prompt_tokens ?? 0,
                parsed.usage.completion_tokens ?? 0,
                model.pricing,
              )
            }
          } catch {
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private buildReasoning(model: KiloModel | undefined): GatewayReasoning | null {
    if (!model) return null

    if (model.reasoningRequired) {
      return { enabled: true, effort: "high" }
    }

    if (!model.supportsReasoning) return null

    switch (this.reasoningEffort) {
      case "off":
        return null
      case "low":
        return { enabled: true, effort: "low" }
      case "medium":
        return { enabled: true, effort: "medium" }
      case "high":
        return { enabled: true, effort: "high", budget_tokens: 32000 }
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
