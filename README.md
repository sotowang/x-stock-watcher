# X Stock Watcher

A backend-free Chrome extension that monitors selected X accounts and extracts actionable stock signals with an OpenAI-compatible AI endpoint.

[![Install from the Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Install-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/x-stock-watcher/lgalfojcmlmpbkookomohmobkpmcflae)

## Install

### Chrome Web Store

[Install X Stock Watcher from the Chrome Web Store](https://chromewebstore.google.com/detail/x-stock-watcher/lgalfojcmlmpbkookomohmobkpmcflae), sign in to `x.com`, then open the extension to add accounts and configure the lookback period.

### Install from source

1. Download or clone this repository.
2. Sign in to `x.com` in Chrome.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and select the `extension` folder.
5. Open **X Stock Watcher**, add accounts, and configure the lookback period.

Chrome must remain open. Each check briefly creates an inactive X profile tab and closes it after reading.

## Configure AI

Enter a complete HTTPS OpenAI-compatible Chat Completions endpoint, model ID, and API Key. The default Agnes example is:

```text
Endpoint: https://apihub.agnes-ai.com/v1/chat/completions
Model: agnes-2.5-flash
```

Chrome will ask for permission to access the endpoint's domain. The API Key is stored in `chrome.storage.local` and sent directly from the extension to that endpoint. This project supplies no intermediary service.

If AI is disabled, permission is denied, or the request fails, the extension falls back to lower-accuracy local keyword rules.

## Scanning behavior

- Scans newest to oldest and reveals the original post when X shows a translation.
- Captures subscriber-only posts visible to the signed-in X account, expands rendered long-post controls, and can extract multiple ticker signals from one post.
- Skips previously checked posts without stopping.
- Stops at the configured lookback boundary, after 500 posts, after three minutes, or when X repeatedly loads no additional posts.
- Replies and reposts can be included or excluded.
- Signals and the latest 500 decision logs are stored locally in Chrome.
- The dashboard supports combined ticker, account, action, type, and direction filters; sortable table columns; original-post links; and filtered CSV export.

## Privacy and limitations

The extension does not directly read X passwords or cookies and never likes, reposts, replies, or places trades. It only sees pages available to the signed-in Chrome profile. X DOM changes, login expiry, rate limiting, browser suspension, and network failures can cause missed posts. AI output is text extraction, not investment advice.

## License

[MIT](LICENSE)
