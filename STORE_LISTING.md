# Chrome Web Store Listing

## Name

X Stock Watcher

## Summary

Monitor selected X accounts and turn stock-related posts into clear, filterable trading signals.

## Detailed description

X Stock Watcher helps investors follow selected public or subscriber-accessible X accounts without manually checking every profile.

The extension periodically opens each selected profile in a background tab, reads posts visible to your signed-in X account, restores the original text when X shows a translation, and identifies explicit trades, recommendations, and directional forecasts.

Key features:

- Monitor multiple X accounts at a configurable interval.
- Limit scanning to posts from the last 1, 3, 7, 14, or 30 days.
- Continue past previously checked posts until reaching the configured time boundary.
- Analyze subscriber-only posts that your X account is authorized to view.
- Extract multiple tickers and signals from long posts.
- Classify trade, recommendation, and forecast signals.
- Identify long/short direction and buy, add, hold, sell, short, cover, or forecast actions.
- Filter by ticker, account, action, type, and direction.
- Sort by confidence and export filtered results to CSV.
- Open the original post from every result.
- Keep detailed local decision logs and send optional desktop notifications.
- Connect directly to a user-selected HTTPS OpenAI-compatible AI endpoint, with a local rules fallback.

X Stock Watcher never places trades and does not provide financial advice. AI classifications can be wrong; always verify the original post and do your own research.

## Category

Productivity

## Language

English

## Privacy policy URL

https://sites.google.com/view/x-stock-watcher-privacy-policy

## Single purpose

Monitor user-selected X profiles and organize stock-related posts into locally stored, filterable trading signals.

## Permission justifications

- `storage`: Save settings, monitored accounts, extracted signals, and logs locally.
- `alarms`: Run checks at the interval selected by the user.
- `tabs`: Open inactive X profile tabs for scanning, close them afterward, and open the dashboard or original posts.
- `notifications`: Notify the user when a new valid stock signal is detected.
- `https://x.com/*`: Read only the X profile and post pages required for monitoring.
- Optional `https://*/*`: Requested for only the user-entered AI endpoint domain so post text can be analyzed directly by that provider.

## Test instructions

1. Sign in to an X account with access to at least one visible profile.
2. Add an X username in the popup.
3. Disable AI analysis to test the local rules without credentials, or configure a reviewer-controlled OpenAI-compatible HTTPS endpoint.
4. Click Check now.
5. Open the signal dashboard to review results and logs.
