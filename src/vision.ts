import * as vscode from "vscode"

export interface VisionResult {
  description: string
  modelUsed: string
}

interface CacheEntry {
  result: VisionResult
  timestamp: number
}

export class VisionProxy {
  private static instance: VisionProxy | null = null
  private cache = new Map<string, CacheEntry>()
  private cacheLimit = 100
  private cacheTtl = 3600000

  static getInstance(): VisionProxy {
    if (!VisionProxy.instance) {
      VisionProxy.instance = new VisionProxy()
    }
    return VisionProxy.instance
  }

  async describeImage(imageData: Uint8Array, mimeType: string): Promise<VisionResult> {
    const cacheKey = this.hashData(imageData, mimeType)
    const cached = this.cache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < this.cacheTtl) {
      console.log("[Kilo LM] Vision cache hit for", mimeType)
      return cached.result
    }

    console.log("[Kilo LM] Vision proxy: describing image", mimeType, "size:", imageData.length)
    const visionModel = await this.selectVisionModel()
    if (!visionModel) {
      throw new Error("No vision-capable model available. Install Claude, GPT-4o, or run 'Kilo: Configure Vision Proxy'.")
    }
    console.log("[Kilo LM] Using vision model:", visionModel.id)

    const prompt = vscode.workspace.getConfiguration("kilo-lm").get<string>("visionPrompt", DEFAULT_VISION_PROMPT)

    try {
      const messages = [
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelDataPart(imageData, mimeType),
          new vscode.LanguageModelTextPart(prompt),
        ]),
      ]

      const tokenSource = new vscode.CancellationTokenSource()
      const response = await visionModel.sendRequest(messages, {}, tokenSource.token)
      let description = ""
      for await (const chunk of response.text) {
        description += chunk
      }
      tokenSource.dispose()

      const result: VisionResult = { description: description.trim(), modelUsed: visionModel.id }

      if (this.cache.size >= this.cacheLimit) {
        const oldest = this.cache.keys().next().value
        if (oldest) this.cache.delete(oldest)
      }
      this.cache.set(cacheKey, { result, timestamp: Date.now() })

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
      (m) =>
        m.vendor === "copilot" ||
        m.id?.toLowerCase().includes("claude") ||
        m.id?.toLowerCase().includes("gpt-4") ||
        m.id?.toLowerCase().includes("gemini") ||
        m.id?.toLowerCase().includes("grok"),
    )

    return visionCapable[0] ?? null
  }

  async configureVisionProxy(): Promise<void> {
    const models = await vscode.lm.selectChatModels()
    const currentId = vscode.workspace.getConfiguration("kilo-lm").get<string>("visionModel")

    const items: vscode.QuickPickItem[] = [
      { label: "$(close) None", description: "Disable vision proxy", detail: "Images will be ignored for text-only models" },
      { label: "$(edit) Customize prompt", description: "Edit the image description prompt" },
      { label: "", kind: vscode.QuickPickItemKind.Separator },
    ]

    const modelItems = models.map((m) => ({
      label: m.id === currentId ? "$(check) " + m.id : m.id,
      description: m.vendor ?? "",
      detail: m.id === currentId ? "Currently selected" : undefined,
    }))

    items.push(...modelItems)

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select vision proxy model (images will be described by this model)",
      matchOnDescription: true,
    })

    if (!picked) return

    if (picked.label === "$(close) None") {
      await vscode.workspace.getConfiguration("kilo-lm").update("visionModel", "", vscode.ConfigurationTarget.Global)
      vscode.window.showInformationMessage("Kilo: Vision proxy disabled")
    } else if (picked.label === "$(edit) Customize prompt") {
      await this.configureVisionPrompt()
    } else {
      const modelId = picked.label.replace("$(check) ", "")
      await vscode.workspace.getConfiguration("kilo-lm").update("visionModel", modelId, vscode.ConfigurationTarget.Global)
      vscode.window.showInformationMessage(`Kilo: Vision proxy set to "${modelId}"`)
    }
  }

  private async configureVisionPrompt(): Promise<void> {
    const current = vscode.workspace.getConfiguration("kilo-lm").get<string>("visionPrompt", DEFAULT_VISION_PROMPT)
    const result = await vscode.window.showInputBox({
      prompt: "Vision proxy prompt",
      value: current,
      ignoreFocusOut: true,
    })
    if (result !== undefined) {
      await vscode.workspace.getConfiguration("kilo-lm").update("visionPrompt", result, vscode.ConfigurationTarget.Global)
    }
  }

  hasVisionCapability(modelId: string): boolean {
    const visionPatterns = ["claude", "gpt-4", "gemini", "grok"]
    return visionPatterns.some((p) => modelId.toLowerCase().includes(p))
  }

  clearCache(): void {
    this.cache.clear()
  }

  private hashData(data: Uint8Array, mimeType: string): string {
    let hash = 0
    const str = mimeType + data.length.toString()
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
    }
    return hash.toString(36)
  }
}

const DEFAULT_VISION_PROMPT = `Text extraction is mandatory. Visual description required unless the image is tightly cropped text-only.

TASK 1 — TEXT EXTRACTION (always):
1. Transcribe every detectable character verbatim — all text, symbols, and glyphs of any kind, in any location. Never correct, alter, summarize, paraphrase, or truncate the source.
2. Preserve formatting: monospaced → code block, proportional → plain text, tabular → Markdown table.
3. Annotate spatial position with [Region: name] headers for multi-region images.
4. Uncertainty markers: [?] = uncertain char, [unclear] = uncertain span, [unreadable] = illegible.

TASK 2 — VISUAL DESCRIPTION (unless tightly cropped text-only):
1. Describe all non-text visual content: window chrome, UI state, colors, diagrams.
2. Diagrams: describe structure — what labels represent, how elements connect.

OUTPUT FORMAT:
--- Extracted Text ---
[transcription]
--- Visual Context ---
[description]

SPECIAL CASES:
- Handwriting: best-effort; prepend "(Handwriting — lower confidence.)"
- No text: output "No text detected."`
