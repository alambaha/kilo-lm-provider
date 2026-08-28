import * as vscode from "vscode"

const API_KEY_STORAGE = "kilo-lm.apiKey"
const GATEWAY_BASE = "https://api.kilo.ai/api/gateway"

export class KiloAuth {
  private apiKey: string | null = null

  constructor(private context: vscode.ExtensionContext) {
    this.loadKey()
  }

  private loadKey(): void {
    this.apiKey = this.context.secrets.get(API_KEY_STORAGE) ?? null
  }

  async login(): Promise<void> {
    const key = await vscode.window.showInputBox({
      prompt: "Enter your Kilo Gateway API Key",
      placeHolder: "JWT token from app.kilo.ai → Profile → API Key",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value) return "API key is required"
        if (value.length < 10) return "API key seems too short"
        return null
      },
    })

    if (!key) return

    this.apiKey = key
    await this.context.secrets.store(API_KEY_STORAGE, key)
    vscode.window.showInformationMessage("Kilo: API key saved successfully")
  }

  async logout(): Promise<void> {
    this.apiKey = null
    await this.context.secrets.delete(API_KEY_STORAGE)
    vscode.window.showInformationMessage("Kilo: API key removed")
  }

  async getAccessToken(): Promise<string | null> {
    if (!this.apiKey) {
      const action = await vscode.window.showWarningMessage(
        "Kilo API key not configured. Please enter your API key.",
        "Enter API Key",
        "Cancel",
      )
      if (action === "Enter API Key") {
        await this.login()
      }
    }
    return this.apiKey
  }

  isAuthenticated(): boolean {
    return this.apiKey !== null
  }

  async validateKey(key: string): Promise<boolean> {
    try {
      const response = await fetch(`${GATEWAY_BASE}/models`, {
        headers: { Authorization: `Bearer ${key}` },
      })
      return response.ok
    } catch {
      return false
    }
  }
}
