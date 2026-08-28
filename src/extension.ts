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
      const current = vscode.workspace.getConfiguration("kilo-lm").get<string>("reasoningEffort", "medium")
      const result = await vscode.window.showQuickPick(
        [
          { label: "$(zap) Off", description: "No reasoning — fastest", value: "off" },
          { label: "$(dash) Low", description: "Minimal thinking", value: "low" },
          { label: "$(circle-large-outline) Medium", description: "Balanced (default)", value: "medium" },
          { label: "$(flame) High", description: "Maximum thinking (more tokens)", value: "high" },
        ],
        { placeHolder: `Reasoning Effort: ${current}` },
      )
      if (result) {
        await vscode.workspace
          .getConfiguration("kilo-lm")
          .update("reasoningEffort", result.value, vscode.ConfigurationTarget.Global)
        vscode.window.showInformationMessage(`Kilo: Reasoning effort set to "${result.value}"`)
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
