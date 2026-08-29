import { storageGet, escapeHtml } from "./shared.js";
let allPosts = [];
let allLogs = [];
let tableSort = { key: "confidence", direction: "desc" };
const $ = id => document.getElementById(id);
const actionLabels = {buy:"Buy",add:"Add",hold:"Hold",sell:"Sell / reduce",short:"Open short",cover:"Cover short",forecast_up:"Bullish target",forecast_down:"Bearish target"};
const typeLabels = {trade:"Trade",recommendation:"Recommendation",forecast:"Forecast"};

function rowsFromPosts(posts) {
  return posts.flatMap(post => (post.analysis?.signals || []).map(signal => ({post, signal})))
    .filter(({signal}) => signal.ticker && ["long","short"].includes(signal.direction));
}

async function load() { const state=await storageGet(); allPosts=state.posts||[]; allLogs=state.logs||[]; render(); }

function syncOptions(id, values, emptyLabel, formatter = value => value) {
  const select = $(id);
  const selected = select.value;
  select.replaceChildren(new Option(emptyLabel, ""), ...values.map(value => new Option(formatter(value), value)));
  if (values.includes(selected)) select.value = selected;
}

function filteredRows() {
  const query = $("search").value.trim().toLowerCase();
  const ticker = $("ticker").value;
  const account = $("account").value;
  const action = $("action").value;
  const type = $("type").value;
  const direction = $("direction").value;
  const rows = rowsFromPosts(allPosts).filter(({post, signal}) =>
    (!query || `${post.handle} ${signal.ticker} ${signal.action} ${signal.signal_type} ${signal.direction} ${signal.conclusion || ""}`.toLowerCase().includes(query)) &&
    (!ticker || signal.ticker === ticker) &&
    (!account || post.handle.toLowerCase() === account) &&
    (!action || signal.action === action) &&
    (!type || signal.signal_type === type) &&
    (!direction || signal.direction === direction));
  return rows.sort(compareSignalRows);
}

function sortableValue({post, signal}, key) {
  if (key === "time") return new Date(post.time || post.capturedAt).getTime() || 0;
  if (key === "confidence") return Number(signal.confidence) || 0;
  if (key === "account") return post.handle || "";
  if (key === "ticker") return signal.ticker || "";
  if (key === "type") return typeLabels[signal.signal_type] || signal.signal_type || "";
  if (key === "direction") return signal.direction || "";
  if (key === "action") return actionLabels[signal.action] || signal.action || "";
  if (key === "conclusion") return signal.conclusion || "";
  return "";
}

function compareSignalRows(a, b) {
  const av = sortableValue(a, tableSort.key);
  const bv = sortableValue(b, tableSort.key);
  const delta = typeof av === "number" ? av - bv : String(av).localeCompare(String(bv), undefined, {numeric:true, sensitivity:"base"});
  if (delta) return tableSort.direction === "asc" ? delta : -delta;
  return (new Date(b.post.time || b.post.capturedAt).getTime() || 0) - (new Date(a.post.time || a.post.capturedAt).getTime() || 0);
}

function renderSortHeaders() {
  document.querySelectorAll("th[data-sort]").forEach(th => {
    const active = th.dataset.sort === tableSort.key;
    th.setAttribute("aria-sort", active ? (tableSort.direction === "asc" ? "ascending" : "descending") : "none");
    th.querySelector(".sort-indicator")?.remove();
    if (active) th.querySelector(".sort-button").insertAdjacentHTML("beforeend", ` <span class="sort-indicator">${tableSort.direction === "asc" ? "▲" : "▼"}</span>`);
  });
}

function render() {
  const query = $("search").value.trim().toLowerCase();
  const sourceRows = rowsFromPosts(allPosts);
  syncOptions("ticker", [...new Set(sourceRows.map(({signal}) => signal.ticker))].sort(), "All tickers", value => `$${value}`);
  syncOptions("account", [...new Set(sourceRows.map(({post}) => post.handle.toLowerCase()))].sort(), "All accounts", value => `@${sourceRows.find(({post}) => post.handle.toLowerCase() === value)?.post.handle || value}`);
  const rows = filteredRows();
  renderSortHeaders();
  const longCount = rows.filter(r=>r.signal.direction==="long").length;
  const shortCount = rows.filter(r=>r.signal.direction==="short").length;
  $("summary").innerHTML = `<div class="card"><strong>${rows.length}</strong><small>Valid signals</small></div><div class="card"><strong>${longCount}</strong><small>Long</small></div><div class="card"><strong>${shortCount}</strong><small>Short</small></div>`;
  $("signals").innerHTML = rows.map(signalRow).join("");
  $("empty").hidden = rows.length > 0;
  renderLogs(query);
}

function renderLogs(query) {
  const status = $("logStatus").value;
  const logs = allLogs.filter(log => (!status || log.status === status) && (!query || `${log.handle} ${log.text} ${log.reason}`.toLowerCase().includes(query)));
  $("logs").innerHTML = logs.map(logRow).join("");
  $("logEmpty").hidden = logs.length > 0;
}

function logRow(log) {
  const labels={recorded:"Recorded",ignored:"AI ignored",filtered:"Filtered",duplicate:"Already checked",boundary:"Time boundary",scraped:"Scrape summary",discord_sent:"Discord queued",discord_duplicate:"Discord duplicate",discord_error:"Discord error",error:"Error"};
  const url=log.url||`https://x.com/${log.handle}`;
  const time=new Date(log.at);
  const displayTime=Number.isNaN(time.getTime())?"—":time.toLocaleString();
  return `<tr><td class="muted">${escapeHtml(displayTime)}</td><td>@${escapeHtml(log.handle||"")}</td><td><span class="status status-${escapeHtml(log.status||"")}">${escapeHtml(labels[log.status]||log.status||"—")}</span></td><td>${escapeHtml(log.reason||"")}</td><td class="preview">${escapeHtml(log.text||"")}</td><td><a class="source" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open ↗</a></td></tr>`;
}

function signalRow({post, signal}) {
  const time = new Date(post.time || post.capturedAt);
  const displayTime = Number.isNaN(time.getTime()) ? "—" : time.toLocaleString();
  const directionLabel = signal.direction === "long" ? "Long" : "Short";
  const prices = [signal.entry_price!=null?`Entry ${signal.entry_price}`:"",signal.target_price!=null?`Target ${signal.target_price}`:"",signal.stop_price!=null?`Stop ${signal.stop_price}`:""].filter(Boolean).join(" · ");
  const conclusion = `${signal.conclusion || "Explicit trading signal"}${prices ? ` (${prices})` : ""}`;
  const subscriberBadge = post.isSubscriberOnly ? `<span class="subscriber-badge" title="Visible only to the author's subscribers">Subscriber-only</span>` : "";
  return `<tr><td class="muted">${escapeHtml(displayTime)}</td><td><span class="account-name">@${escapeHtml(post.handle)}</span>${subscriberBadge}</td><td class="ticker">${escapeHtml(signal.ticker)}</td><td>${escapeHtml(typeLabels[signal.signal_type] || "Trade")}</td><td><span class="direction ${signal.direction}">${directionLabel}</span></td><td class="action">${escapeHtml(actionLabels[signal.action] || signal.action || "—")}</td><td class="conclusion">${escapeHtml(conclusion)}</td><td>${Math.round((Number(signal.confidence)||0)*100)}%</td><td><a class="source" href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">View post ↗</a></td></tr>`;
}

$("search").addEventListener("input", render);
for (const id of ["ticker", "account", "action", "type", "direction"]) $(id).addEventListener("change", render);
document.querySelectorAll(".column-filter").forEach(filter => filter.addEventListener("click", event => event.stopPropagation()));
document.querySelectorAll("th[data-sort]").forEach(th => th.addEventListener("click", () => {
  const key = th.dataset.sort;
  if (tableSort.key === key) tableSort.direction = tableSort.direction === "asc" ? "desc" : "asc";
  else tableSort = { key, direction: ["time", "confidence"].includes(key) ? "desc" : "asc" };
  render();
}));
$("logStatus").addEventListener("change", render);
$("clearLogs").addEventListener("click", async () => { await chrome.storage.local.set({logs:[]}); allLogs=[]; render(); });
$("clear").addEventListener("click", async () => { if(confirm("Clear all historical signals and reanalyze using the selected lookback period on the next check?")){ await chrome.storage.local.set({posts:[],seenIds:{}}); allPosts=[]; render(); }});
$("export").addEventListener("click", () => {
  const rows=filteredRows(); const esc=v=>`"${String(v??"").replaceAll('"','""')}"`;
  const csv=[["Time","Account","Subscriber-only","Ticker","Type","Direction","Action","Conclusion","Confidence","Original post URL"],...rows.map(({post,signal})=>[post.time||post.capturedAt,`@${post.handle}`,post.isSubscriberOnly?"Yes":"No",signal.ticker,typeLabels[signal.signal_type]||"Trade",signal.direction==="long"?"Long":"Short",actionLabels[signal.action]||signal.action,signal.conclusion,signal.confidence,post.url])].map(row=>row.map(esc).join(",")).join("\n");
  const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=`x-stock-signals-${new Date().toISOString().slice(0,10)}.csv`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
});
chrome.storage.onChanged.addListener(changes => { if(changes.posts) allPosts=changes.posts.newValue||[]; if(changes.logs) allLogs=changes.logs.newValue||[]; if(changes.posts||changes.logs) render(); });
load();
