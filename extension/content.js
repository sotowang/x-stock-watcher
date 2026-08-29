(() => {
  if (window.__xStockWatcherInstalled) return;
  window.__xStockWatcherInstalled = true;
  const activatedControls = new WeakSet();

  function statusIdFromArticle(article) {
    const timeLink = article.querySelector("time")?.closest('a[href*="/status/"]');
    const links = [timeLink, ...article.querySelectorAll('a[href*="/status/"]')].filter(Boolean);
    for (const link of links) {
      const match = link.getAttribute("href")?.match(/\/([^/]+)\/status\/(\d+)/);
      if (match) return { handle: match[1], id: match[2], url: new URL(link.href, location.origin).href };
    }
    return null;
  }

  function originalTextFromArticle(article) {
    const nodes = [...article.querySelectorAll('[data-testid="tweetText"]')]
      .filter(node => !node.parentElement?.closest('[data-testid="tweetText"]'));
    const texts = [...new Set(nodes.map(node => node.innerText.trim()).filter(Boolean))];
    // After “Show original”, X may keep both the author's text and its
    // automatic translation in the DOM. The original is rendered first.
    return texts[0] || "";
  }

  function scrape() {
    return [...document.querySelectorAll('article[data-testid="tweet"]')].map(article => {
      const identity = statusIdFromArticle(article);
      if (!identity) return null;
      const text = originalTextFromArticle(article);
      const timeNode = article.querySelector("time");
      const time = timeNode?.getAttribute("datetime") || timeNode?.dateTime || null;
      const isRepost = /reposted|转发了|轉發了/i.test(article.innerText.split("\n").slice(0, 3).join(" "));
      const isPinned = /^(pinned|已置顶|已置頂)$/im.test(article.innerText.split("\n").slice(0, 4).join("\n"));
      const headerLines = article.innerText.split("\n").slice(0, 10).map(line => line.trim());
      // X labels subscriber-only posts as "Subscribers" in English and
      // "订阅者" / "訂閱者" in its Chinese interfaces. Match a complete
      // header line so a normal post mentioning subscribers is not mislabeled.
      const isSubscriberOnly = headerLines.some(line => /^(subscribers?|订阅者|訂閱者)$/i.test(line));
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
    let scrollSteps = 0;
    let renderedArticles = 0;
    const poll = () => {
      const contentExpanded = revealPostContent();
      if (contentExpanded) {
        setTimeout(poll, 500);
        return;
      }
      const previousSize = collected.size;
      const visiblePosts = scrape();
      renderedArticles += document.querySelectorAll('article[data-testid="tweet"]').length;
      for (const post of visiblePosts) collected.set(post.id, post);
      unchangedRounds = collected.size === previousSize ? unchangedRounds + 1 : 0;
      const chronological = [...collected.values()].filter(post => !post.isPinned);
      const olderThanCutoff = chronological.filter(post => post.time && new Date(post.time).getTime() < cutoff).length;
      // Requiring more than one old post avoids stopping on a single
      // out-of-order module while the profile still has in-range posts below.
      const reachedCutoff = olderThanCutoff >= 2;
      const stopReason = reachedCutoff ? "time_boundary"
        : collected.size >= 500 ? "safety_limit"
        : unchangedRounds >= 20 ? "end_of_feed"
        : Date.now() >= deadline ? "timeout"
        : "";
      if (stopReason) {
        sendResponse({ posts: [...collected.values()], title: document.title, url: location.href, stopReason, scrollSteps, renderedArticles });
      } else {
        // X virtualizes its timeline. Small steps ensure intermediate cards are
        // rendered and observed instead of being skipped by a jump to the end.
        window.scrollBy({ top: Math.max(600, Math.floor(window.innerHeight * 0.8)), behavior: "instant" });
        scrollSteps++;
        setTimeout(poll, 1100);
      }
    };
    poll();
    return true;
  });
})();
