// Gateway integration proofs use the real channel custody without booting a transport.
export { telegramApprovalCapability } from "./src/approval-native.js";
export { listTelegramAccountIds, resolveDefaultTelegramAccountId } from "./src/accounts.js";
export { getOrCreateAccountThrottler } from "./src/account-throttler.js";
export { renderTelegramProgressDraftPreview } from "./src/progress-draft-preview.js";
export { telegramHtmlToPlainTextFallback } from "./src/format.js";
export { resolveTelegramMessageCacheScope } from "./src/message-cache-persistence.js";
export { createTelegramMessageCache } from "./src/message-cache.js";
export {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./src/runtime.test-support.js";
