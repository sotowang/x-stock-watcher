import { normalizeHandle, storageGet, escapeHtml } from "./shared.js";

let state;
const $ = id => document.getElementById(id);

async function load() {
  state = await storageGet();
  render();
}

function render() {
  $("statusDot").classList.toggle("on", state.running);
  $("statusText").textContent = state.running ? "Monitoring" : "Stopped";
  $("interval").value = String(state.intervalMinutes);
  $("maxAgeDays").value = String(state.maxAgeDays);
  $("useAI").checked = state.useAI;
  $("aiEndpoint").value = state.aiEndpoint;
  $("aiApiKey").value = state.aiApiKey;
  $("aiModel").value = state.aiModel;
  $("discordEnabled").checked = state.discordEnabled;
  $("discordRelayEndpoint").value = state.discordRelayEndpoint;
  $("discordRelayToken").value = state.discordRelayToken;
  $("discordWebhookURL").value = state.discordWebhookURL;
  $("testDiscord").disabled = !state.discordRelayEndpoint || !state.discordRelayToken || !state.discordWebhookURL;
  $("toggle").textContent = state.running ? "Stop monitoring" : "Start monitoring";
  $("toggle").className = state.running ? "danger" : "primary";
  $("handles").innerHTML = state.handles.length
    ? state.handles.map(handle => `<span class="tag">@${escapeHtml(handle)}<button data-remove="${escapeHtml(handle)}" title="Remove">×</button></span>`).join("")
    : '<span class="empty">No accounts added</span>';
  const last = state.lastRunAt ? new Date(state.lastRunAt).toLocaleTimeString() : "Never";
  $("message").textContent = state.lastError || `Last checked: ${last}`;
}

async function save(patch) {
  state = { ...state, ...patch };
  await chrome.storage.local.set(patch);
  await chrome.runtime.sendMessage({ type: "CONFIG_CHANGED" });
  render();
}

function endpointPattern(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

function relayEndpoint() {
  return $("discordRelayEndpoint").value.trim().replace(/\/+$/, "");
}

async function ensureEndpointPermission() {
  if (!$("useAI").checked) return true;
  const origin = endpointPattern($("aiEndpoint").value.trim());
  if (!origin) {
    $("message").textContent = "Enter a valid HTTPS AI endpoint";
    return false;
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) $("message").textContent = "AI endpoint access was denied; local rules will be used";
  return granted;
}

async function ensureRelayPermission() {
  if (!$("discordEnabled").checked && !$("discordRelayEndpoint").value.trim()) return true;
  const endpoint = relayEndpoint();
  const origin = endpointPattern(endpoint);
  if (!origin || !endpoint) {
    $("message").textContent = "Enter a valid HTTPS relay server URL";
    return false;
  }
  if (!$("discordRelayToken").value.trim()) {
    $("message").textContent = "Enter the relay access token";
    return false;
  }
  if (!/^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\//i.test($("discordWebhookURL").value.trim())) {
    $("message").textContent = "Enter a valid Discord channel webhook URL";
    return false;
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) $("message").textContent = "Relay server access was denied";
  return granted;
}

$("addForm").addEventListener("submit", async event => {
  event.preventDefault();
  const handle = normalizeHandle($("handleInput").value);
  if (!handle) return;
  await save({ handles: [...new Set([...state.handles, handle])] });
  $("handleInput").value = "";
});

$("handles").addEventListener("click", async event => {
  const handle = event.target.dataset.remove;
  if (handle) await save({ handles: state.handles.filter(item => item !== handle) });
});

for (const id of ["interval", "maxAgeDays", "useAI", "aiEndpoint", "aiModel", "aiApiKey", "discordEnabled", "discordRelayEndpoint", "discordRelayToken", "discordWebhookURL"]) {
  $(id).addEventListener("change", async () => {
    if ((id === "useAI" || id === "aiEndpoint") && !(await ensureEndpointPermission())) return;
    if (["discordEnabled", "discordRelayEndpoint", "discordWebhookURL"].includes(id) && $("discordEnabled").checked && !(await ensureRelayPermission())) { render(); return; }
    await save({
      intervalMinutes: Number($("interval").value),
      maxAgeDays: Number($("maxAgeDays").value),
      useAI: $("useAI").checked,
      aiEndpoint: $("aiEndpoint").value.trim(),
      aiModel: $("aiModel").value.trim() || "agnes-2.5-flash",
      aiApiKey: $("aiApiKey").value.trim(),
      discordEnabled: $("discordEnabled").checked,
      discordRelayEndpoint: relayEndpoint(),
      discordRelayToken: $("discordRelayToken").value.trim(),
      discordWebhookURL: $("discordWebhookURL").value.trim()
    });
  });
}

$("testDiscord").addEventListener("click", async () => {
  if (!(await ensureRelayPermission())) return;
  $("message").textContent = "Sending Discord test message…";
  const result = await chrome.runtime.sendMessage({
    type: "TEST_DISCORD_RELAY",
    endpoint: relayEndpoint(),
    token: $("discordRelayToken").value.trim(),
    webhookUrl: $("discordWebhookURL").value.trim()
  });
  $("message").textContent = result.ok ? "Discord test message sent." : `Discord test failed: ${result.error}`;
});

$("toggle").addEventListener("click", async () => {
  if (!state.running && !state.handles.length) {
    $("message").textContent = "Add at least one account first";
    return;
  }
  if (!state.running && !(await ensureEndpointPermission())) return;
  await save({ running: !state.running });
});

$("poll").addEventListener("click", async () => {
  if (!state.handles.length) return;
  if (!(await ensureEndpointPermission())) return;
  $("message").textContent = "Checking now; a background tab will open briefly…";
  await chrome.storage.local.set({ running: true });
  const result = await chrome.runtime.sendMessage({ type: "POLL_NOW" });
  state = await storageGet();
  $("message").textContent = result.ok ? `Done. Found ${result.found} new signal(s).` : result.error;
  render();
});

$("dashboard").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" }));
load();
