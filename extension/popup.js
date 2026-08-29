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

for (const id of ["interval", "maxAgeDays", "useAI", "aiEndpoint", "aiModel", "aiApiKey"]) {
  $(id).addEventListener("change", async () => {
    if ((id === "useAI" || id === "aiEndpoint") && !(await ensureEndpointPermission())) return;
    await save({
    intervalMinutes: Number($("interval").value),
    maxAgeDays: Number($("maxAgeDays").value),
    useAI: $("useAI").checked,
    aiEndpoint: $("aiEndpoint").value.trim(),
    aiModel: $("aiModel").value.trim() || "agnes-2.5-flash",
      aiApiKey: $("aiApiKey").value.trim()
    });
  });
}

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
