import type { CodexServerNotification } from "./protocol.js";

const GLOBAL_WARNING_LIMIT = 32;
const DELIVERED_THREAD_LIMIT = 256;

export class CodexGlobalWarnings {
  private readonly warnings: CodexGlobalWarning[] = [];

  pendingFor(threadId: string): CodexGlobalWarning[] {
    return this.warnings.filter((warning) => !warning.wasDeliveredTo(threadId));
  }

  record(notification: CodexServerNotification): CodexGlobalWarning {
    if (this.warnings.length === GLOBAL_WARNING_LIMIT) {
      this.warnings.shift();
    }
    const warning = new CodexGlobalWarning(notification);
    this.warnings.push(warning);
    return warning;
  }
}

// One native receipt, not a warning-text key. New receipts must remain visible.
export class CodexGlobalWarning {
  private readonly deliveredThreadIds = new Set<string>();
  private readonly inFlight = new Map<string, Promise<boolean | void>>();

  constructor(readonly notification: CodexServerNotification) {}

  wasDeliveredTo(threadId: string): boolean {
    return this.deliveredThreadIds.has(threadId);
  }

  async deliver(
    threadId: string,
    project: () => Promise<boolean | void> | boolean | void,
  ): Promise<void> {
    for (
      let pending = this.inFlight.get(threadId);
      pending;
      pending = this.inFlight.get(threadId)
    ) {
      // A replaced route can still be projecting. Join it, but retry its failure.
      await pending.catch(() => {});
    }
    if (this.wasDeliveredTo(threadId)) {
      return;
    }
    const delivery = Promise.resolve().then(project);
    this.inFlight.set(threadId, delivery);
    try {
      if ((await delivery) !== true) {
        return;
      }
      // Only acknowledged projection consumes replay; failed/unbound routes retry.
      // Evict old receipts rather than grow with every thread on a shared client.
      if (this.deliveredThreadIds.size === DELIVERED_THREAD_LIMIT) {
        const oldest = this.deliveredThreadIds.values().next().value;
        if (oldest !== undefined) {
          this.deliveredThreadIds.delete(oldest);
        }
      }
      this.deliveredThreadIds.add(threadId);
    } finally {
      this.inFlight.delete(threadId);
    }
  }
}
