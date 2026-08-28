import * as vscode from "vscode"
import { KiloAuth } from "./auth"
import { KiloModelProvider } from "./models"
import { KiloChatProvider } from "./chat-provider"
import { UsageTracker } from "./usage"

export function activate(context: vscode.ExtensionContext) {
  const auth = new KiloAuth(context)
  const modelProvider = new KiloModelProvider(auth)
  const chatProvider = new KiloChatProvider(auth, modelProvider)
  const usageTracker = UsageTracker.getInstance()

  const provider = vscode.lm.registerLanguageModelChatProvider("kilo", chatProvider)
  context.subscriptions.push(provider)

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
}

export function deactivate() {}
