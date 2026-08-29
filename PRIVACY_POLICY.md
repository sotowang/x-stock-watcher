# Privacy Policy for X Stock Watcher

Effective date: August 23, 2026

X Stock Watcher monitors X profiles selected by the user and extracts stock-related trading signals from posts that the user's signed-in X account is permitted to view.

## Data handled

The extension handles monitored X account names; visible post text, URLs, timestamps, and media URLs; extracted stock signals; check logs; extension settings; and the AI endpoint, model, and API key entered by the user.

## How data is used and stored

This data is used only to provide the extension's monitoring, analysis, notification, dashboard, filtering, export, and optional Discord relay features. Settings, posts, signals, logs, API keys, and relay access tokens are stored locally in Chrome extension storage.

When AI analysis is enabled, the post text and the configured model name are sent directly over HTTPS to the AI endpoint selected by the user. The API key is sent to that endpoint in the Authorization header. The selected AI provider processes this data under its own terms and privacy policy. Users should only configure providers they trust.

When Discord relay delivery is enabled, the extension sends the user-provided Discord webhook URL and structured signal fields—X post ID, account handle, original-post URL and timestamp, subscriber-only flag, ticker, signal type, direction, action, confidence, and a short AI-generated conclusion—to the HTTPS relay server configured by the user. It does not send the full subscriber-only post text or images to the relay. The relay access token is sent in the Authorization header. The relay may retain the destination webhook, delivery identifiers, status, retry metadata, and the structured signal payload for deduplication and reliable delivery to the configured Discord channel.

## Sharing, advertising, and sale

The extension does not sell user data, use it for advertising, or transfer it to data brokers. Data is transferred only to the user-selected AI provider when necessary to perform the requested analysis and, when explicitly enabled, to the user-configured relay and Discord for signal delivery.

## Retention and deletion

Local data remains in Chrome until the user clears signals or logs, removes configuration, clears extension storage, or uninstalls the extension. Data retained by a selected AI provider is controlled by that provider's policy. Relay retention is controlled by the relay operator; the included self-hosted relay can be configured and maintained by the user, who is responsible for deleting old delivery records.

## Security

AI and relay endpoints must use HTTPS. The extension requests access only to X and to HTTPS endpoint domains approved by the user. No system can be guaranteed completely secure, and users are responsible for protecting their API keys and relay tokens.

## Chrome Web Store Limited Use

The use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide or improve the extension's single user-facing purpose.

## Contact

Publisher contact: sootowang@gmail.com
