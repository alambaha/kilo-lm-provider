export interface UsageEntry {
  timestamp: number
  model: string
  promptTokens: number
  completionTokens: number
  cost: number
}

export interface UsageSummary {
  sessionTokens: number
  sessionCost: number
  totalTokens: number
  totalCost: number
  requestCount: number
}

export class UsageTracker {
  private static instance: UsageTracker | null = null
  private entries: UsageEntry[] = []
  private sessionStart = Date.now()
  private _onUsageChanged = new Map<string, () => void>()

  static getInstance(): UsageTracker {
    if (!UsageTracker.instance) {
      UsageTracker.instance = new UsageTracker()
    }
    return UsageTracker.instance
  }

  record(model: string, promptTokens: number, completionTokens: number, pricing: { prompt: number; completion: number }): void {
    const cost = (promptTokens * pricing.prompt + completionTokens * pricing.completion) / 1_000_000
    this.entries.push({
      timestamp: Date.now(),
      model,
      promptTokens,
      completionTokens,
      cost,
    })
    this.notifyListeners()
  }

  getSessionSummary(): UsageSummary {
    const sessionEntries = this.entries.filter((e) => e.timestamp >= this.sessionStart)
    return {
      sessionTokens: sessionEntries.reduce((sum, e) => sum + e.promptTokens + e.completionTokens, 0),
      sessionCost: sessionEntries.reduce((sum, e) => sum + e.cost, 0),
      totalTokens: this.entries.reduce((sum, e) => sum + e.promptTokens + e.completionTokens, 0),
      totalCost: this.entries.reduce((sum, e) => sum + e.cost, 0),
      requestCount: sessionEntries.length,
    }
  }

  onUsageChanged(key: string, callback: () => void): void {
    this._onUsageChanged.set(key, callback)
  }

  removeListener(key: string): void {
    this._onUsageChanged.delete(key)
  }

  private notifyListeners(): void {
    for (const cb of this._onUsageChanged.values()) {
      cb()
    }
  }

  resetSession(): void {
    this.sessionStart = Date.now()
    this.notifyListeners()
  }
}
