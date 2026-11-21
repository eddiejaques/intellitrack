# Chrome Web Store listing

The text and answers to paste into the Chrome Web Store Developer Dashboard. The MVP is **Unlisted**: only people with the link can install it. A public listing comes with B7. Keep this file true to what the code does. When a permission or what it is used for changes (for example the dataLayer observer, B2, also uses `scripting`), update the justification here and in the dashboard before the next release.

## Store listing tab

**Name:** IntelliTrack

**Category:** Developer Tools

**Single purpose** (the dashboard asks for it under *Privacy*):
> IntelliTrack records the marketing and analytics tags (such as Google Analytics 4 and Google Ads) that fire in a tab while you browse it, and audits them against the journey you expect, with rules and optionally your own LLM.

**Short description** (132 characters at most):
> Record GA4 and Google Ads tags while you browse a site, then audit them with built-in rules and your own LLM.

**Long description:**
> IntelliTrack is for analysts, marketers and developers who need to know whether a site's tracking actually works.
>
> Press Start on the site you want to check and browse it like a visitor. IntelliTrack records every tag request in that tab, and in tabs it opens: GA4 (including server-side GTM and first-party endpoints), Google Ads conversions and enhanced conversions, and any other tag-like request, shown raw.
>
> Then audit the session:
> • Built-in rules find missing events and parameters, wrong values, duplicate conversions, plaintext personal data, consent problems, failed hits, and GA4-vs-Ads mismatches. No account or LLM needed.
> • Optionally, bring your own LLM (Anthropic, OpenAI, Google Gemini or an OpenAI-compatible endpoint). IntelliTrack plans the journey for the site and reviews the findings. You preview exactly what is sent first, and personal data is redacted.
>
> Private by design: nothing is recorded unless you press Start, sessions stay in your browser, there is no IntelliTrack server and no telemetry, and your LLM requests go straight from your browser to the endpoint you configure.

**Language:** English

## Privacy tab

### Permission justifications

| Permission | Why IntelliTrack needs it |
|---|---|
| `webRequest` | Observes (never blocks or changes) the tag requests a recorded tab makes, so they can be parsed and audited. Requests from tabs that aren't being recorded are ignored. |
| Host permission `<all_urls>` | Analytics tags are sent to many hosts, including first-party and server-side endpoints on the audited site's own domain, which can't be listed in advance. The same access lets IntelliTrack read the page structure of the recorded tab for journey planning. |
| `scripting` | Reads the structure of the recorded page (title, headings, navigation labels, form field types, schema.org types) to plan the journey. No form values, no input names, no cookies. |
| `activeTab` | Lets the popup act on the tab you are looking at when you press Start. (Overlaps with the host permission; kept for the popup's current-tab flow.) |
| `sidePanel` | Shows the live log of captured tags next to the page while you record. |
| `webNavigation` | Follows tabs that the recorded tab opens (a product opened in a new tab, a checkout pop-up), so the journey isn't lost. |
| `storage` | Keeps the current recording's state across service-worker restarts (`chrome.storage.session`), and your settings, per-site consent choices and LLM settings (`chrome.storage.local`). |
| `unlimitedStorage` | Sessions (captured tags, events and reports) are stored locally in IndexedDB and can outgrow the default quota on long journeys. |
| Optional host permissions (`https://*/*`, `http://*/*`) | Asked for only when you enter a custom LLM endpoint, so the browser can reach it. |

**Remote code:** *No, I am not using remote code.* All code ships in the package. Network requests to the LLM endpoint you configure send and receive data only; no code is downloaded or executed.

### Data usage

Answer the dashboard's checklist as follows. **The PM should confirm these before submitting**, because they are a legal statement.

Data the extension handles:

- **Website content.** The recorded page's structure is sent to *your own* LLM endpoint for journey planning, according to your per-site choice (*Always*, *Ask each time*, *Never*).
- **Web browsing activity.** The page URLs inside the recorded tab's tag requests. These are stored locally. An audit sends a minimized version (URL queries dropped, IDs in paths become `:id`) to your own LLM, only after you preview and confirm it.

- **Authentication information.** Your own LLM API key, entered in Settings. It is stored unencrypted in `chrome.storage.local` on your machine and sent only to the provider you configured, as that API requires. Nobody else receives it.

Not handled: personally identifiable information, health, financial or payment, personal communications, location. Emails, phone numbers and hashes found in tags are redacted to placeholders before anything is sent, and sending is blocked if the payload still looks like it holds personal data.

Certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases. Data goes only to the LLM provider *you* configure, at your request.
- I do not use or transfer user data for purposes unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** the dashboard requires one because the extension handles website content. Use the README's [Privacy section](../README.md#privacy), or a page made from it, until there is a site.

## Graphics needed

The dashboard holds these. They aren't in the repo.

| Asset | Size | Notes |
|---|---|---|
| Store icon | 128×128 PNG | `extension/static/icons/icon-128.png` |
| Screenshots | 1280×800 (or 640×400) JPEG or 24-bit PNG (no alpha), 1 to 5 | Ready to upload in `docs/screenshots/store/`, in this order: `1-popup.png` (recording), `2-live-panel.png`, `3-session-log.png`, `4-audit-preview.png`, `5-report.png`. All are 1280×800 24-bit PNGs without alpha, checked by `tests/storeshots.test.ts`. To refresh them after a UI change, run `npm run build && npm run screenshots`. They come from the local test shop with placeholder IDs, never a real customer's site. |
| Small promo tile | 440×280 PNG | Required by the dashboard |
| Marquee promo tile | 1400×560 PNG | Optional |
