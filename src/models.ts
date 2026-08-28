import * as vscode from "vscode"
import { KiloAuth } from "./auth"

const GATEWAY_BASE = "https://api.kilo.ai/api/gateway"

export interface ReasoningVariant {
  key: string
  effort: string
  enabled: boolean
}

export interface KiloModel {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  supportsTools: boolean
  supportsImages: boolean
  supportsReasoning: boolean
  reasoningRequired: boolean
  reasoningVariants: ReasoningVariant[]
  pricing: { prompt: number; completion: number }
}

interface OpenRouterModel {
  id: string
  name: string
  context_length: number
  max_completion_tokens?: number
  supported_parameters?: string[]
  architecture?: { output_modalities?: string[] }
  pricing?: { prompt: string; completion: string }
  opencode?: {
    variants?: Record<string, { reasoning?: { enabled?: boolean; effort?: string } }>
  }
}

export interface CustomModel {
  id: string
  name: string
  baseUrl: string
  contextLength: number
  maxOutputTokens: number
  supportsTools: boolean
  supportsImages: boolean
  supportsReasoning: boolean
  apiKey?: string
  pricing?: { prompt: number; completion: number }
}

export class KiloModelProvider {
  private models: KiloModel[] = []
  private customModels: CustomModel[] = []
  private lastFetch = 0
  private cacheTtl = 3600000

  constructor(private auth: KiloAuth) {
    this.loadCustomModels()
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kilo-lm.customModels")) {
        this.loadCustomModels()
      }
    })
  }

  private loadCustomModels(): void {
    const config = vscode.workspace.getConfiguration("kilo-lm")
    this.customModels = config.get<CustomModel[]>("customModels", [])
  }

  getCustomModels(): CustomModel[] {
    return this.customModels
  }

  getCustomModelBaseUrl(modelId: string): string | null {
    const custom = this.customModels.find((m) => m.id === modelId)
    return custom?.baseUrl ?? null
  }

  isCustomModel(modelId: string): boolean {
    return this.customModels.some((m) => m.id === modelId)
  }

  getCustomModelApiKey(modelId: string): string | null {
    const custom = this.customModels.find((m) => m.id === modelId)
    return custom?.apiKey ?? null
  }

  async refresh(): Promise<void> {
    await this.fetchModels(true)
  }

  async getModels(): Promise<KiloModel[]> {
    const gatewayModels = await this.getGatewayModels()
    const custom: KiloModel[] = this.customModels.map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.contextLength,
      maxOutputTokens: m.maxOutputTokens,
      supportsTools: m.supportsTools,
      supportsImages: m.supportsImages,
      supportsReasoning: m.supportsReasoning,
      reasoningRequired: false,
      reasoningVariants: [],
      pricing: m.pricing ?? { prompt: 0, completion: 0 },
    }))
    return [...gatewayModels, ...custom].sort((a, b) => a.name.localeCompare(b.name))
  }

  private async getGatewayModels(): Promise<KiloModel[]> {
    if (this.models.length > 0 && Date.now() - this.lastFetch < this.cacheTtl) {
      return this.models
    }
    await this.fetchModels()
    return this.models
  }

  private extractReasoningVariants(m: OpenRouterModel): ReasoningVariant[] {
    const variants: ReasoningVariant[] = []
    const opencodeVariants = m.opencode?.variants
    if (!opencodeVariants) return variants

    for (const [key, value] of Object.entries(opencodeVariants)) {
      const reasoning = value.reasoning
      if (reasoning) {
        variants.push({
          key,
          effort: reasoning.effort ?? "none",
          enabled: reasoning.enabled ?? false,
        })
      }
    }
    return variants
  }

  private async fetchModels(force = false): Promise<void> {
    if (!force && this.models.length > 0 && Date.now() - this.lastFetch < this.cacheTtl) {
      return
    }

    try {
      const token = await this.auth.getAccessToken()
      const headers: Record<string, string> = {}
      if (token) {
        headers["Authorization"] = `Bearer ${token}`
      }

      const response = await fetch(`${GATEWAY_BASE}/models`, { headers })
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`)
      }

      const data: { data: OpenRouterModel[] } = await response.json()
      this.models = data.data
        .filter((m) => !m.architecture?.output_modalities?.includes("image"))
        .filter((m) => !m.supported_parameters || m.supported_parameters.includes("tools"))
        .map((m) => {
          const variants = this.extractReasoningVariants(m)
          return {
            id: m.id,
            name: m.name,
            contextLength: m.context_length,
            maxOutputTokens: m.max_completion_tokens ?? Math.min(m.context_length, 32768),
            supportsTools: !m.supported_parameters || m.supported_parameters.includes("tools"),
            supportsImages: m.supported_parameters?.includes("image") ?? false,
            supportsReasoning: variants.length > 0,
            reasoningRequired: variants.length === 1 && variants[0].enabled,
            reasoningVariants: variants,
            pricing: {
              prompt: parseFloat(m.pricing?.prompt ?? "0"),
              completion: parseFloat(m.pricing?.completion ?? "0"),
            },
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))

      this.lastFetch = Date.now()
    } catch (err) {
      console.error("[Kilo LM] Failed to fetch models:", err)
      if (this.models.length === 0) {
        this.getFallbackModels()
      }
    }
  }

  private getFallbackModels(): void {
    this.models = [
      { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7", contextLength: 200000, maxOutputTokens: 32768, supportsTools: true, supportsImages: true, supportsReasoning: true, reasoningRequired: false, reasoningVariants: [{ key: "high", effort: "high", enabled: true }], pricing: { prompt: 0.000015, completion: 0.000075 } },
      { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextLength: 200000, maxOutputTokens: 32768, supportsTools: true, supportsImages: true, supportsReasoning: true, reasoningRequired: false, reasoningVariants: [{ key: "high", effort: "high", enabled: true }], pricing: { prompt: 0.000003, completion: 0.000015 } },
    ]
    this.lastFetch = Date.now()
  }
}
