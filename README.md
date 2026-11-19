# IntelliTrack

IntelliTrack is a Manifest V3 Chrome extension for auditing GA4 along a journey you record in one tab. It captures standard and first-party GA4 collection requests, checks them against a journey plan, and exports an audit as Markdown or JSON. Local rules work without a provider. An optional LLM can propose a plan and review the minimized recording.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Select **Load unpacked** and choose the [extension](extension/) directory from this checkout.
3. Pin IntelliTrack to the Chrome toolbar.

The extension loads directly from source. No backend, dependencies, or build step is required.

## Record a journey

1. Open the site you want to audit and choose **Start** in the IntelliTrack popup.
2. Select a manual site type or configure an LLM under **Settings** and approve sending page context. Choose a proposed journey and deselect any steps you plan to skip.
3. Walk through the journey in that tab. Reopen the popup to see the live GA4 checklist or mark a step.
4. Choose **Stop**. Review the local findings and the minimized JSON. Export the report, or choose **Send this preview** to request an LLM review.

## Provider settings and privacy

Settings support OpenAI, Anthropic, Gemini, and OpenAI-compatible endpoints such as Ollama. Choose a model, enter the API base URL and key if required, save, and use **Test saved connection**. Planning calls honor the configured per-session limit and minimum interval.

The extension needs access to all sites because GA4 requests can go to a first-party domain. Recording begins with **Start** and the recording is stored in IndexedDB. Sessions are eligible for cleanup after 30 days. The raw event viewer is local. Page context is sent only when you request a plan and approve the site. The minimized audit payload is sent only after you confirm its preview. Inspect the preview before sending it because automated redaction has limits.

Chrome stores provider keys unencrypted in local extension storage. Use a dedicated key with a spending cap.

## Development and verification

Run the local parser, redaction, rules, adapter, and evidence tests with Node.js 22 or newer.

```sh
npm test
```

Run the planner and audit evaluation against live providers by passing a private JSON file keyed by `openai`, `anthropic`, `gemini`, and `openai_compatible`. Each entry can override `base_url`, `model`, and `api_key`. The evaluation sends synthetic fixtures to each configured endpoint and may incur provider charges.

```sh
npm run eval -- /path/to/providers.json
```

The included fixtures are synthetic. The GA4 DebugView capture benchmark, checkout through service-worker suspension, and live checks across the four providers are acceptance checks that need real sites and provider access. See the [MVP plan](plan.md) for the full criteria.
