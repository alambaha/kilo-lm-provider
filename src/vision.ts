import * as vscode from "vscode"

export interface VisionResult {
  description: string
  modelUsed: string
}

export class VisionProxy {
  private static instance: VisionProxy | null = null
  private cache = new Map<string, VisionResult>()
  private cacheLimit = 100

  static getInstance(): VisionProxy {
    if (!VisionProxy.instance) {
      VisionProxy.instance = new VisionProxy()
    }
    return VisionProxy.instance
  }

  async describeImage(imageData: string, mimeType: string): Promise<VisionResult> {
    const cacheKey = `${imageData}:${mimeType}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const visionModel = await this.selectVisionModel()
    if (!visionModel) {
      throw new Error("No vision-capable model available. Install a model like Claude or GPT-4o for image support.")
    }

    const prompt = vscode.workspace
      .getConfiguration("kilo-lm")
      .get<string>(
        "visionPrompt",
        "Describe the visual contents of this image in detail, including any text, objects, people, UI elements, or code that would be relevant for understanding it. Focus on factual visual elements.",
      )

    const messages = [
      vscode.LanguageModelChatMessage.User(prompt),
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelTextPart("[Image: " + mimeType + "]"),
      ]),
    ]

    try {
      const response = await visionModel.sendRequest(messages, {}, new vscode.CancellationTokenSource().token)
      let description = ""
      for await (const chunk of response.text) {
        description += chunk
      }

      const result: VisionResult = { description, modelUsed: visionModel.id }

      if (this.cache.size >= this.cacheLimit) {
        const firstKey = this.cache.keys().next().value
        if (firstKey) this.cache.delete(firstKey)
      }
      this.cache.set(cacheKey, result)

      return result
    } catch (err) {
      throw new Error(`Vision proxy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async selectVisionModel(): Promise<vscode.LanguageModelChat | null> {
    const configured = vscode.workspace.getConfiguration("kilo-lm").get<string>("visionModel")
    const models = await vscode.lm.selectChatModels()

    if (configured) {
      const match = models.find((m) => m.id === configured || m.name === configured)
      if (match) return match
    }

    const visionCapable = models.filter(
      (m) => m.vendor === "copilot" || m.name?.toLowerCase().includes("claude") || m.name?.toLowerCase().includes("gpt-4"),
    )

    return visionCapable[0] ?? models[0] ?? null
  }

  hasVisionCapability(modelId: string): boolean {
    const visionPatterns = ["claude", "gpt-4", "gemini", "grok"]
    return visionPatterns.some((p) => modelId.toLowerCase().includes(p))
  }

  clearCache(): void {
    this.cache.clear()
  }
}
