import * as vscode from "vscode"
import { KiloAuth } from "./auth"
import { KiloModelProvider } from "./models"
import { KiloChatProvider } from "./chat-provider"
import { UsageTracker } from "./usage"

export function activate(context: vscode.ExtensionContext) {
  console.log("[Kilo LM] Extension activating...")
  try {
  const auth = new KiloAuth(context)
  const modelProvider = new KiloModelProvider(auth)
  const chatProvider = new KiloChatProvider(auth, modelProvider)
  const usageTracker = UsageTracker.getInstance()

  const provider = vscode.lm.registerLanguageModelChatProvider("kilo", chatProvider)
  context.subscriptions.push(provider)
  console.log("[Kilo LM] Language model provider registered")

  // Fix: configurationSchema (Thinking Effort dropdown) is a non-public
  // field that Copilot Chat does not persist in its chatLanguageModels.json
  // cache. On startup, Copilot Chat initialises the model picker from cache
  // and silently drops configurationSchema, so the per-model config menu
  // never appears on first launch.
  //
  // Re-firing onDidChangeLanguageModelChatInformation here forces Copilot
  // Chat to re-query our provider through the full (non-cached) path, which
  // correctly picks up configurationSchema.
  //
  // This works because registerLanguageModelChatProvider() is synchronous,
  // so the provider is fully registered before we fire the refresh and the
  // host has already subscribed to receive the change. Copilot Chat can then
  // re-query complete model information through the non-cached path. The
  // extensionDependencies on github.copilot-chat in package.json
  // additionally guarantees Copilot Chat is fully activated before this
  // extension's activate() runs, eliminating any activation ordering race.
  provider.refreshModelPicker()

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.text = "$(brain) Kilo"
  statusBar.tooltip = "Kilo Gateway — Click for usage info"
  statusBar.command = "kilo-lm.showUsage"
  statusBar.show()
  context.subscriptions.push(statusBar)

  const updateStatusBar = () => {
    const summary = usageTracker.getSessionSummary()
    if (summary.requestCount > 0) {
      statusBar.text = "$(brain) Kilo: $" + summary.sessionCost.toFixed(3)
      statusBar.tooltip = `Kilo Gateway Usage\nSession: $${summary.sessionCost.toFixed(4)} (${summary.sessionTokens.toLocaleString()} tokens)\nRequests: ${summary.requestCount}`
    } else {
      statusBar.text = "$(brain) Kilo"
      statusBar.tooltip = "Kilo Gateway — Click for usage info"
    }
  }
  usageTracker.onUsageChanged("statusbar", updateStatusBar)

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-lm.login", async () => {
      await auth.login()
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-lm.logout", async () => {
      await auth.logout()
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-lm.refreshModels", async () => {
      await modelProvider.refresh()
      vscode.window.showInformationMessage("Kilo: Models refreshed")
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-lm.setReasoningEffort", async () => {
      const result = await vscode.window.showQuickPick(
        [
          { label: "$(flame) DeepSeek", description: "Set thinking effort for DeepSeek models", value: "deepseek" },
          { label: "$(flame) GLM", description: "Set thinking effort for GLM models", value: "glm" },
          { label: "$(flame) Kimi", description: "Set thinking for Kimi models", value: "kimi" },
          { label: "$(flame) MiniMax", description: "Set thinking for MiniMax models", value: "minimax" },
          { label: "$(flame) MiMo", description: "Set thinking effort for MiMo models", value: "mimo" },
          { label: "$(flame) Qwen", description: "Set thinking for Qwen models", value: "qwen" },
        ],
        { placeHolder: "Select model family" },
      )
      if (!result) return

      const family = result.value
      const config = vscode.workspace.getConfiguration("kilo-lm")

      if (family === "deepseek") {
        const pick = await vscode.window.showQuickPick(
          [
            { label: "$(zap) Off", value: "off" },
            { label: "$(dash) Low", value: "low" },
            { label: "$(circle-large-outline) Medium", value: "medium" },
            { label: "$(flame) High", value: "high" },
            { label: "$(rocket) Max", value: "max" },
          ],
          { placeHolder: "DeepSeek thinking effort" },
        )
        if (pick) {
          await config.update("thinking.deepseek", pick.value, vscode.ConfigurationTarget.Global)
          vscode.window.showInformationMessage(`Kilo: DeepSeek thinking set to "${pick.value}"`)
        }
      } else if (family === "qwen") {
        const pick = await vscode.window.showQuickPick(
          [
            { label: "$(zap) Off", value: "off" },
            { label: "$(sync) Auto", value: "auto" },
            { label: "$(check) On", value: "on" },
          ],
          { placeHolder: "Qwen thinking mode" },
        )
        if (pick) {
          await config.update("thinking.qwen", pick.value, vscode.ConfigurationTarget.Global)
          vscode.window.showInformationMessage(`Kilo: Qwen thinking set to "${pick.value}"`)
        }
      } else if (family === "minimax" || family === "kimi" || family === "glm") {
        const pick = await vscode.window.showQuickPick(
          [
            { label: "$(zap) Off", value: "off" },
            { label: "$(check) On", value: "on" },
          ],
          { placeHolder: `${family} thinking` },
        )
        if (pick) {
          await config.update(`thinking.${family}`, pick.value, vscode.ConfigurationTarget.Global)
          vscode.window.showInformationMessage(`Kilo: ${family} thinking set to "${pick.value}"`)
        }
      } else if (family === "mimo") {
        const pick = await vscode.window.showQuickPick(
          [
            { label: "$(zap) Off", value: "off" },
            { label: "$(dash) Low", value: "low" },
            { label: "$(circle-large-outline) Medium", value: "medium" },
            { label: "$(flame) High", value: "high" },
          ],
          { placeHolder: "MiMo thinking effort" },
        )
        if (pick) {
          await config.update("thinking.mimo", pick.value, vscode.ConfigurationTarget.Global)
          vscode.window.showInformationMessage(`Kilo: MiMo thinking set to "${pick.value}"`)
        }
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-lm.configureVisionProxy", async () => {
      await chatProvider.visionProxy.configureVisionProxy()
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-lm.testVisionProxy", async () => {
      try {
        const models = await vscode.lm.selectChatModels()
        const visionModels = models.filter(
          (m) =>
            m.vendor === "copilot" ||
            m.id?.toLowerCase().includes("claude") ||
            m.id?.toLowerCase().includes("gpt-4") ||
            m.id?.toLowerCase().includes("gemini") ||
            m.id?.toLowerCase().includes("grok"),
        )
        if (visionModels.length === 0) {
          vscode.window.showWarningMessage("No vision-capable models found. Install Claude, GPT-4o, or Gemini.")
          return
        }
        vscode.window.showInformationMessage(
          `Found ${visionModels.length} vision model(s): ${visionModels.map((m) => m.id).join(", ")}`,
        )
      } catch (err) {
        vscode.window.showErrorMessage(`Vision test failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-lm.showUsage", async () => {
      const summary = usageTracker.getSessionSummary()
      const action = await vscode.window.showInformationMessage(
        `Kilo Gateway Usage\n` +
          `Session cost: $${summary.sessionCost.toFixed(4)}\n` +
          `Session tokens: ${summary.sessionTokens.toLocaleString()}\n` +
          `Requests: ${summary.requestCount}\n` +
          `Total cost: $${summary.totalCost.toFixed(4)}`,
        "Reset Session",
        "Refresh Models",
      )
      if (action === "Reset Session") {
        usageTracker.resetSession()
        vscode.window.showInformationMessage("Kilo: Session usage reset")
      } else if (action === "Refresh Models") {
        await modelProvider.refresh()
        vscode.window.showInformationMessage("Kilo: Models refreshed")
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-lm.showDiagnostics", async () => {
      const models = await modelProvider.getModels()
      const log = chatProvider.getRequestLog()
      const summary = usageTracker.getSessionSummary()

      const lines: string[] = [
        "# Kilo Gateway Diagnostics",
        "",
        "## Models",
        `${models.length} models available`,
        "",
        "## Session Usage",
        `- Requests: ${summary.requestCount}`,
        `- Session tokens: ${summary.sessionTokens.toLocaleString()}`,
        `- Session cost: $${summary.sessionCost.toFixed(4)}`,
        `- Total cost: $${summary.totalCost.toFixed(4)}`,
        "",
        "## Request Log",
        `${log.length} requests logged`,
        "",
      ]

      if (log.length > 0) {
        lines.push("| Time | Model | Status | Duration | Error |")
        lines.push("|------|-------|--------|----------|-------|")
        for (const entry of log.slice(-20)) {
          const time = new Date(entry.timestamp).toLocaleTimeString()
          lines.push(
            `| ${time} | ${entry.model} | ${entry.status} | ${entry.duration}ms | ${entry.error ?? "-"} |`,
          )
        }
      }

      const doc = await vscode.workspace.openTextDocument({
        content: lines.join("\n"),
        language: "markdown",
      })
      await vscode.window.showTextDocument(doc, { preview: true })
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-lm.clearLogs", async () => {
      chatProvider.clearRequestLog()
      vscode.window.showInformationMessage("Kilo: Request logs cleared")
    }),
  )

  const hasShownWelcome = context.globalState.get<boolean>("kilo-lm.welcomeShown")
  if (!hasShownWelcome) {
    vscode.window
      .showInformationMessage(
        "Kilo Gateway is ready! Get your API key from app.kilo.ai → Profile → API Key.",
        "Enter API Key",
        "Later",
      )
      .then((action) => {
        if (action === "Enter API Key") {
          vscode.commands.executeCommand("kilo-lm.login")
        }
      })
    context.globalState.update("kilo-lm.welcomeShown", true)
  }
  } catch (err) {
    console.error("[Kilo LM] Activation error:", err)
    throw err
  }
}

export function deactivate() {}
