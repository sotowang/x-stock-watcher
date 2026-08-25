(() => {
  if (window.__xStockWatcherInstalled) return;
  window.__xStockWatcherInstalled = true;
  const activatedControls = new WeakSet();

  function statusIdFromArticle(article) {
    const links = [...article.querySelectorAll('a[href*="/status/"]')];
    for (const link of links) {
      const match = link.getAttribute("href")?.match(/\/([^/]+)\/status\/(\d+)/);
      if (match) return { handle: match[1], id: match[2], url: new URL(link.href, location.origin).href };
    }
    return null;
  }

  function scrape() {
    return [...document.querySelectorAll('article[data-testid="tweet"]')].map(article => {
      const identity = statusIdFromArticle(article);
      if (!identity) return null;
      const text = [...article.querySelectorAll('[data-testid="tweetText"]')]
        .map(node => node.innerText.trim()).filter(Boolean).join("\n");
      const timeNode = article.querySelector("time");
      const time = timeNode?.getAttribute("datetime") || timeNode?.dateTime || null;
      const isRepost = /reposted|转发了|轉發了/i.test(article.innerText.split("\n").slice(0, 3).join(" "));
      const isPinned = /^(pinned|已置顶|已置頂)$/im.test(article.innerText.split("\n").slice(0, 4).join("\n"));
      const isSubscriberOnly = /\bsubscribers?\b|订阅者|訂閱者/i.test(article.innerText.split("\n").slice(0, 8).join(" "));
      // Do not scan the entire article: Chinese engagement buttons contain "回复"
      // on every post. A real reply context includes an @handle next to the label.
      const replying = [...article.querySelectorAll('div[dir="ltr"], span')]
        .some(node => /^(replying to|回复|回覆)\s+@/i.test((node.innerText || "").trim()));
      const images = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
        .map(img => img.src).filter(Boolean);
      return { ...identity, text, time, isRepost, isPinned, isSubscriberOnly, isReply: replying, images };
    }).filter(Boolean);
  }

  function revealPostContent() {
    let clicked = 0;
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const buttons = [...article.querySelectorAll('[role="button"]')];
      const original = buttons.find(button => !activatedControls.has(button) && /^(show original|显示原文|顯示原文)$/i.test((button.innerText || "").trim()));
      if (original) {
        activatedControls.add(original);
        original.click();
        clicked++;
        continue;
      }
      const expand = buttons.find(button => !activatedControls.has(button) && /^(show more|read more|显示更多|顯示更多|展开|展開)$/i.test((button.innerText || "").trim()));
      if (expand) {
        activatedControls.add(expand);
        expand.click();
        clicked++;
      }
    }
    return clicked;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SCRAPE_PROFILE") return;
    const deadline = Date.now() + 180000;
    const collected = new Map();
    const cutoff = Date.now() - Math.max(1, Number(message.maxAgeDays) || 1) * 86400000;
    let unchangedRounds = 0;
    const poll = () => {
      const contentExpanded = revealPostContent();
      if (contentExpanded) {
        setTimeout(poll, 500);
        return;
      }
      const previousSize = collected.size;
      for (const post of scrape()) collected.set(post.id, post);
      unchangedRounds = collected.size === previousSize ? unchangedRounds + 1 : 0;
      const chronological = [...collected.values()].filter(post => !post.isPinned);
      const reachedCutoff = chronological.some(post => post.time && new Date(post.time).getTime() < cutoff);
      const stopReason = reachedCutoff ? "time_boundary"
        : collected.size >= 500 ? "safety_limit"
        : unchangedRounds >= 20 ? "end_of_feed"
        : Date.now() >= deadline ? "timeout"
        : "";
      if (stopReason) {
        sendResponse({ posts: [...collected.values()], title: document.title, url: location.href, stopReason });
      } else {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
        setTimeout(poll, 1500);
      }
    };
    poll();
    return true;
  });
})();
