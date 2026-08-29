import { DEFAULTS, storageGet } from "./shared.js";

const ALARM = "x-stock-watcher-poll";
const TEMP_TABS_KEY = "temporaryScanTabs";
let polling = false;
const startupCleanup = cleanupOrphanedScanTabs();

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set(current);
  await chrome.storage.local.remove(["includeReplies", "includeReposts"]);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) pollAll();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CONFIG_CHANGED") {
    configureAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "POLL_NOW") {
    pollAll().then(result => sendResponse(result));
    return true;
  }
  if (message?.type === "OPEN_DASHBOARD") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    sendResponse({ ok: true });
  }
  if (message?.type === "TEST_DISCORD") {
    testDiscordWebhook(message.webhookUrl).then(result => sendResponse(result));
    return true;
  }
});

async function configureAlarm() {
  const config = await storageGet();
  await chrome.alarms.clear(ALARM);
  if (config.running && config.handles.length) {
    await chrome.alarms.create(ALARM, {
      delayInMinutes: 0.05,
      periodInMinutes: Math.max(1, Number(config.intervalMinutes) || 2)
    });
  }
}

async function pollAll() {
  if (polling) return { ok: false, error: "A monitoring run is already in progress" };
  polling = true;
  try {
    await startupCleanup;
    const config = await storageGet();
    if (!config.running && !config.manualPoll) {
      return { ok: false, error: "Monitoring is not enabled" };
    }

    let found = 0;
    let lastError = null;
    for (const handle of config.handles) {
      try {
        found += await pollHandle(handle, config);
      } catch (error) {
        lastError = `@${handle}: ${error.message}`;
        await appendLogs([{ handle, status: "error", reason: error.message, text: "", postId: null, url: `https://x.com/${handle}` }]);
      }
      await delay(1200);
    }
    await flushDiscordOutbox(await storageGet());
    await chrome.storage.local.set({ lastRunAt: new Date().toISOString(), lastError });
    return { ok: true, found, lastError };
  } finally {
    polling = false;
  }
}

async function pollHandle(handle, config) {
  const tab = await chrome.tabs.create({ url: `https://x.com/${handle}`, active: false });
  await trackScanTab(tab.id, handle);
  try {
    await waitForTab(tab.id, 20000);
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await chrome.tabs.sendMessage(tab.id, {
          type: "SCRAPE_PROFILE",
          knownIds: config.seenIds?.[handle] || [],
          maxAgeDays: config.maxAgeDays || 1
        });
        break;
      } catch {
        await delay(1200);
      }
    }
    if (!response) throw new Error("Unable to read the page. Make sure you are signed in to X");
    if (/log in|sign in|登录/i.test(response.title || "")) throw new Error("Your X session has expired");
    const stopLabels = {
      time_boundary: "reached the configured time boundary",
      end_of_feed: "X loaded no additional posts",
      safety_limit: "reached the 500-post safety limit",
      timeout: "reached the 3-minute scan limit"
    };
    const subscriberCount = (response.posts || []).filter(post => post.isSubscriberOnly).length;
    await appendLogs([{ handle, status: "scraped", reason: `Read ${response.posts?.length || 0} post(s) while scrolling down (${subscriberCount} subscriber-only); ${stopLabels[response.stopReason] || "scan completed"}. Previously checked posts were skipped without stopping the scan.`, text: "", postId: null, url: `https://x.com/${handle}` }]);
    return await ingestPosts(handle, response.posts || [], config);
  } finally {
    if (tab?.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      await untrackScanTab(tab.id);
    }
  }
}

async function trackScanTab(tabId, handle) {
  if (!tabId) return;
  const stored = await chrome.storage.local.get({ [TEMP_TABS_KEY]: [] });
  const tabs = stored[TEMP_TABS_KEY].filter(item => item.tabId !== tabId);
  tabs.push({ tabId, handle, openedAt: Date.now() });
  await chrome.storage.local.set({ [TEMP_TABS_KEY]: tabs });
}

async function untrackScanTab(tabId) {
  const stored = await chrome.storage.local.get({ [TEMP_TABS_KEY]: [] });
  await chrome.storage.local.set({
    [TEMP_TABS_KEY]: stored[TEMP_TABS_KEY].filter(item => item.tabId !== tabId)
  });
}

async function cleanupOrphanedScanTabs() {
  const stored = await chrome.storage.local.get({ [TEMP_TABS_KEY]: [] });
  const tracked = stored[TEMP_TABS_KEY];
  if (!tracked.length) return;

  for (const item of tracked) {
    try {
      const tab = await chrome.tabs.get(item.tabId);
      const expected = `https://x.com/${item.handle}`.toLowerCase();
      if ((tab.url || "").toLowerCase().startsWith(expected)) {
        await chrome.tabs.remove(item.tabId);
      }
    } catch {
      // The tab was already closed, so only its stale tracking entry remains.
    }
  }
  await chrome.storage.local.set({ [TEMP_TABS_KEY]: [] });
}

async function ingestPosts(expectedHandle, scraped, config) {
  const state = await storageGet();
  const seen = { ...state.seenIds };
  const known = new Set(seen[expectedHandle] || []);
  const firstRun = known.size === 0;
  const cutoff = Date.now() - Math.max(1, Number(config.maxAgeDays) || 1) * 86400000;
  const candidates = [];
  const filterLogs = [];
  for (const post of scraped) {
    let reason = "";
    if (post.handle.toLowerCase() !== expectedHandle.toLowerCase()) reason = `Author mismatch: @${post.handle}`;
    else if (post.isPinned) reason = "Pinned posts do not act as a stopping boundary";
    else if (post.isReply) reason = "Reply excluded";
    else if (post.isRepost) reason = "Repost excluded";
    if (reason) {
      filterLogs.push(postLog(post, expectedHandle, "filtered", reason));
      continue;
    }
    if (post.time && new Date(post.time).getTime() < cutoff) {
      filterLogs.push(postLog(post, expectedHandle, "boundary", `Post exceeds the ${config.maxAgeDays || 1}-day lookback limit; stopping`));
      break;
    }
    if (known.has(post.id)) {
      filterLogs.push(postLog(post, expectedHandle, "duplicate", "Already checked; skipped while continuing toward the configured time boundary."));
      continue;
    }
    candidates.push(post);
  }
  if (filterLogs.length) await appendLogs(filterLogs);
  seen[expectedHandle] = [...new Set([...candidates.map(p => p.id), ...known])].slice(0, 200);
  const analyzed = [];
  const analysisLogs = [];
  for (const post of candidates) {
    const analysis = await analyze(post, config);
    if (!isRelevant(analysis)) {
      analysisLogs.push(postLog(post, expectedHandle, "ignored", `${post.isSubscriberOnly ? "Subscriber post · " : ""}${analysis?.ignore_reason || "AI returned no valid trading signal"}`));
      continue;
    }
    const record = { ...post, analysis, capturedAt: new Date().toISOString(), baseline: firstRun };
    analyzed.push(record);
    analysisLogs.push(postLog(post, expectedHandle, "recorded", `${post.isSubscriberOnly ? "Subscriber post · " : ""}${signalSummary(analysis)}`));
    if (!firstRun) {
      await notify(record);
      await enqueueDiscordSignal(record, config);
    }
  }
  if (analysisLogs.length) await appendLogs(analysisLogs);

  const latestState = await storageGet();
  const posts = [...analyzed, ...latestState.posts]
    .filter((post, index, all) => all.findIndex(p => p.id === post.id) === index)
    .slice(0, 1000);
  await chrome.storage.local.set({ posts, seenIds: seen });
  return analyzed.length;
}

async function analyze(post, config) {
  if (config.useAI) {
    try {
      const response = await fetch(config.aiEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.aiApiKey ? { Authorization: `Bearer ${config.aiApiKey}` } : {})
        },
        body: JSON.stringify({
          model: config.aiModel,
          messages: [
            { role: "system", content: AI_SYSTEM_PROMPT },
            { role: "user", content: post.text }
          ],
          stream: false,
          temperature: 0.1,
          max_tokens: 2000
        })
      });
      if (!response.ok) throw new Error(`AI endpoint returned HTTP ${response.status}`);
      const payload = await response.json();
      return parseAIAnalysis(payload?.choices?.[0]?.message?.content || "");
    } catch (error) {
      const fallback = ruleAnalysis(post.text);
      fallback.ai_error = error.message;
      if (!fallback.relevant) fallback.ignore_reason = `AI unavailable; local rules found no explicit signal (${error.message})`;
      return fallback;
    }
  }
  return ruleAnalysis(post.text);
}

const AI_SYSTEM_PROMPT = `You are a strict stock trade-signal extractor. The input is normally the author's ORIGINAL English post. Return JSON only:
{"relevant":false,"signals":[{"ticker":"TSLA","signal_type":"trade|recommendation|forecast","direction":"long|short","action":"buy|add|hold|sell|short|cover|forecast_up|forecast_down","horizon":"intraday|short|swing|long|unclear","entry_price":null,"target_price":null,"stop_price":null,"condition":null,"confidence":0.0,"conclusion":"one concise English sentence"}],"ignore_reason":"short English reason"}
Include a signal only for the author's own current trade/position, a concrete intended trade, explicit recommendation, or concrete directional forecast with a target price or technical trigger. Preserve negation and conditions. Use trade for actual actions/positions, recommendation for explicit advice, and forecast for directional targets without a stated trade. A target or technical trigger is not automatically a buy. Ignore news, generic commentary, completed historical profit recaps, motivation, questions without a view, watchlists, quoted third-party trades, and vague bullishness. A completed past trade is not a current position. Ticker must be a listed stock/ETF symbol, never ordinary words such as NEXT, WEEK, AI, CEO, USD, LONG, SHORT, BUY or SELL. direction=long for buy/add/hold/sell/forecast_up and short for short/cover/forecast_down. Exclude confidence below 0.65.`;

function parseAIAnalysis(content) {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("AI returned no JSON");
  const result = JSON.parse(content.slice(start, end + 1));
  const actions = new Set(["buy", "add", "hold", "sell", "short", "cover", "forecast_up", "forecast_down"]);
  const types = new Set(["trade", "recommendation", "forecast"]);
  const directions = new Set(["long", "short"]);
  const invalid = new Set(["NEXT", "WEEK", "AI", "CEO", "USD", "LONG", "SHORT", "BUY", "SELL"]);
  result.signals = (Array.isArray(result.signals) ? result.signals : []).filter(signal => {
    signal.ticker = String(signal.ticker || "").replace(/^\$/, "").trim().toUpperCase();
    signal.signal_type ||= "trade";
    signal.confidence = Math.min(1, Number(signal.confidence) || 0);
    return /^[A-Z]{1,5}$/.test(signal.ticker) && !invalid.has(signal.ticker) && actions.has(signal.action) && types.has(signal.signal_type) && directions.has(signal.direction) && signal.confidence >= 0.65;
  });
  result.relevant = result.signals.length > 0;
  result.analyzer = "direct-openai";
  return result;
}

function ruleAnalysis(text = "") {
  const cashtags = [...text.matchAll(/\$([A-Z]{1,5})(?![A-Z])/g)].map(m => m[1]);
  const tickers = [...new Set(cashtags)].slice(0, 8);
  const tests = [
    ["cover", "short", /\b(covered|covering my short)\b|平空|空单止盈/i],
    ["short", "short", /\b(shorted|shorting|opened a short)\b|做空|开空|開空/i],
    ["sell", "long", /\b(sold|exited|closed my long|liquidated|trimmed|reduced|took profits?)\b|卖出|賣出|清仓|清倉|减仓|減倉|止盈/i],
    ["add", "long", /\b(added|adding|scaled in|bought more)\b|加仓|加倉/i],
    ["buy", "long", /\b(bought|buying|initiated|started a position|went long)\b|买入|買入|建仓|建倉|做多/i],
    ["hold", "long", /\b(holding|hold|staying long)\b|持有|继续拿|繼續持有/i]
  ];
  const matched = tests.find(([, , regex]) => regex.test(text));
  const signals = matched ? tickers.map(ticker => ({
    ticker,
    signal_type: "trade",
    direction: matched[1],
    action: matched[0],
    horizon: "unclear",
    entry_price: null,
    target_price: null,
    stop_price: null,
    confidence: 0.66,
    conclusion: `Rule-based detection: ${matched[0]}`
  })) : [];
  return {
    relevant: signals.length > 0,
    signals,
    ignore_reason: signals.length ? "" : "No explicit trading signal",
    analyzer: "rules"
  };
}

function isRelevant(analysis) {
  return analysis?.relevant === true && Array.isArray(analysis.signals) && analysis.signals.length > 0;
}

function postLog(post, handle, status, reason) {
  return {
    at: new Date().toISOString(),
    handle,
    postId: post.id,
    url: post.url,
    status,
    reason,
    text: (post.text || "[Media post]").slice(0, 500)
  };
}

function signalSummary(analysis) {
  return analysis.signals.map(signal => `${signal.ticker} / ${signal.direction} / ${signal.action}`).join("; ");
}

function discordPayload(post) {
  const signals = (post.analysis?.signals || [])
    .slice(0, 10)
    .map(signal => ({
      ticker: signal.ticker,
      type: signal.signal_type,
      direction: signal.direction,
      action: signal.action,
      confidence: Number(signal.confidence) || 0,
      conclusion: String(signal.conclusion || "").slice(0, 500)
    }));
  if (!post.isSubscriberOnly || !signals.length) return null;
  return {
    postId: post.id,
    handle: post.handle,
    postUrl: post.url,
    postTime: post.time || post.capturedAt,
    subscriberOnly: true,
    signals
  };
}

async function enqueueDiscordSignal(post, config) {
  if (!config.discordEnabled || !config.discordWebhookURL) return;
  const payload = discordPayload(post);
  if (!payload) return;
  payload.discordWebhookUrl = config.discordWebhookURL;
  const { discordOutbox = [] } = await chrome.storage.local.get({ discordOutbox: [] });
  if (discordOutbox.some(item => item.postId === payload.postId && item.payload.discordWebhookUrl === payload.discordWebhookUrl)) return;
  if (discordOutbox.length >= 200) {
    await appendLogs([{ handle: post.handle, status: "discord_error", reason: "Discord outbox is full; signal was not queued", text: "", postId: post.id, url: post.url }]);
    return;
  }
  const entry = { postId: payload.postId, handle: post.handle, payload, attempts: 0, nextAttemptAt: 0 };
  await chrome.storage.local.set({ discordOutbox: [...discordOutbox, entry] });
}

async function flushDiscordOutbox(config) {
  if (!config.discordEnabled || !config.discordWebhookURL) return;
  const now = Date.now();
  const remaining = [];
  const deliveryLogs = [];
  let attempted = 0;
  for (const item of config.discordOutbox || []) {
    if ((item.nextAttemptAt || 0) > now || attempted >= 20) { remaining.push(item); continue; }
    attempted++;
    try {
      await sendDiscordWebhook(item.payload.discordWebhookUrl, item.payload);
      deliveryLogs.push({ handle: item.handle, status: "discord_sent", reason: "Subscriber-only signal sent to Discord", text: "", postId: item.postId, url: item.payload.postUrl });
    } catch (error) {
      const attempts = (item.attempts || 0) + 1;
      const retryMinutes = Math.min(60, 2 ** Math.min(attempts, 6));
      remaining.push({ ...item, attempts, nextAttemptAt: now + retryMinutes * 60000 });
      deliveryLogs.push({ handle: item.handle, status: "discord_error", reason: `${error.message}; retry scheduled`, text: "", postId: item.postId, url: item.payload.postUrl });
    }
  }
  await chrome.storage.local.set({ discordOutbox: remaining });
  if (deliveryLogs.length) await appendLogs(deliveryLogs);
}

async function testDiscordWebhook(webhookUrl) {
  try {
    await sendDiscordWebhook(webhookUrl, {
      handle: "XStockWatcher",
      postUrl: "https://x.com/",
      signals: [{ ticker: "TEST", direction: "long", action: "test", confidence: 1, conclusion: "Direct Discord webhook connection is working." }]
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function sendDiscordWebhook(webhookUrl, payload) {
  const webhook = new URL(webhookUrl);
  if (webhook.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(webhook.hostname) || !webhook.pathname.startsWith("/api/webhooks/")) {
    throw new Error("Invalid Discord webhook URL");
  }
  webhook.searchParams.set("wait", "true");
  const fields = payload.signals.map(signal => ({
    name: `$${signal.ticker} · ${titleWord(signal.direction)} · ${actionLabel(signal.action)}`,
    value: `${signal.conclusion || "Explicit stock signal"}\n**Confidence:** ${Math.round((Number(signal.confidence) || 0) * 100)}%`,
    inline: false
  }));
  const response = await fetch(webhook.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "X Stock Watcher",
      embeds: [{
        title: `🔒 Subscriber-only signal · @${payload.handle}`,
        url: payload.postUrl,
        color: 0xa21caf,
        fields,
        footer: { text: "X Stock Watcher · Open the original post to verify access and context" },
        ...(payload.postTime ? { timestamp: payload.postTime } : {})
      }],
      allowed_mentions: { parse: [] }
    })
  });
  if (!response.ok) {
    if (response.status === 429) throw new Error("Discord rate limited the webhook");
    throw new Error(`Discord returned HTTP ${response.status}`);
  }
}

function titleWord(value = "") {
  return value ? value[0].toUpperCase() + value.slice(1) : "Signal";
}

function actionLabel(value = "") {
  return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase()) || "Signal";
}

async function appendLogs(entries) {
  const { logs = [] } = await chrome.storage.local.get({ logs: [] });
  const stamped = entries.map(entry => ({ at: entry.at || new Date().toISOString(), ...entry }));
  await chrome.storage.local.set({ logs: [...stamped.reverse(), ...logs].slice(0, 500) });
}

async function notify(post) {
  const a = post.analysis || {};
  const signal = a.signals?.[0] || {};
  const extra = a.signals?.length > 1 ? ` +${a.signals.length - 1}` : "";
  const title = `@${post.handle} · ${signal.ticker || "Stock"} · ${signal.direction || "Signal"}${extra}`;
  const message = `${signal.conclusion || post.text || "[Media post]"}`.slice(0, 220);
  await chrome.notifications.create(post.id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    priority: 1
  });
}

chrome.notifications.onClicked.addListener(async notificationId => {
  const { posts } = await storageGet();
  const post = posts.find(item => item.id === notificationId);
  if (post?.url) chrome.tabs.create({ url: post.url });
});

function waitForTab(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Page load timed out")), timeout);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    function finish(error) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => tab.status === "complete" && finish()).catch(() => {});
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
configureAlarm();
