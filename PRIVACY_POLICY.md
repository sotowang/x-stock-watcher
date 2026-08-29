# Privacy Policy for X Stock Watcher

Effective date: August 23, 2026

X Stock Watcher monitors X profiles selected by the user and extracts stock-related trading signals from posts that the user's signed-in X account is permitted to view.

## Data handled

The extension handles monitored X account names; visible post text, URLs, timestamps, and media URLs; extracted stock signals; check logs; extension settings; and the AI endpoint, model, and API key entered by the user.

## How data is used and stored

This data is used only to provide the extension's monitoring, analysis, notification, dashboard, filtering, export, and optional Discord delivery features. Settings, posts, signals, logs, API keys, and the Discord webhook URL are stored locally in Chrome extension storage.

When AI analysis is enabled, the post text and the configured model name are sent directly over HTTPS to the AI endpoint selected by the user. The API key is sent to that endpoint in the Authorization header. The selected AI provider processes this data under its own terms and privacy policy. Users should only configure providers they trust.

When Discord delivery is enabled, the extension sends the original post text and structured signal fields—account handle, original-post URL and timestamp, ticker, signal type, direction, action, and a short AI-generated conclusion—directly to the user-provided Discord webhook. Long post text may be delivered as a text attachment. Images are not sent to Discord, and neither the webhook nor the content is sent to the publisher.

## Sharing, advertising, and sale

The extension does not sell user data, use it for advertising, or transfer it to data brokers. Data is transferred only to the user-selected AI provider when necessary to perform the requested analysis and, when explicitly enabled, directly to the user-selected Discord webhook.

## Retention and deletion

Local data remains in Chrome until the user clears signals or logs, removes configuration, clears extension storage, or uninstalls the extension. Data retained by a selected AI provider or Discord is controlled by that provider's policy.

## Security

AI endpoints and Discord webhooks must use HTTPS. The extension requests access only to X and to HTTPS endpoint domains approved by the user. No system can be guaranteed completely secure, and users are responsible for protecting their API keys and Discord webhook URLs.

## Chrome Web Store Limited Use

The use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide or improve the extension's single user-facing purpose.

## Contact

Publisher contact: sootowang@gmail.com
