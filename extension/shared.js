export const DEFAULTS = {
  handles: [],
  intervalMinutes: 2,
  maxAgeDays: 1,
  running: false,
  useAI: true,
  aiEndpoint: "https://apihub.agnes-ai.com/v1/chat/completions",
  aiApiKey: "",
  aiModel: "agnes-2.5-flash",
  discordEnabled: false,
  discordWebhookURL: "",
  discordOutbox: [],
  discordDeliveredKeys: [],
  posts: [],
  logs: [],
  seenIds: {},
  lastRunAt: null,
  lastError: null
};

export function normalizeHandle(value) {
  return value.trim().replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, "")
    .replace(/^@/, "").split(/[/?#]/)[0].replace(/[^A-Za-z0-9_]/g, "").slice(0, 15);
}

export function storageGet() {
  return chrome.storage.local.get(DEFAULTS);
}

export function escapeHtml(value = "") {
  return value.replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}
