# IntelliTrack — Plan

A Chrome extension that records the tracking tags fired during a user-driven journey on any website. It sends a minimized log to **the user's own LLM** and returns an audit: what's working, what's missing, what's wrong, and what could be better.

- **Platform:** Chrome, Manifest V3. Edge, Brave, and Arc run the same build. Safari is a backlog item.
- **No backend.** Users bring their own LLM: Claude, OpenAI, Gemini, or any OpenAI-compatible gateway. Calls go directly from the extension to the endpoint the user configures.
- **Works on any site type:** the LLM looks at the site when you land on it and proposes the journeys and events to expect (§6).
- **MVP = GA4 only**, built in 7 sub-tasks (§1). Everything that was cut is in a prioritized Kanban backlog (§9). Vendor integration notes for Salesforce, Braze, and others are in §10.

---

## 1. MVP: scope and 7 sub-tasks

### What the MVP does

1. You open the popup on any site and press **Start**.
2. The LLM proposes a journey plan for this site:
   - e-commerce: *PDP → add to cart → checkout → purchase*
   - lead generation: *landing → form start → generate_lead*
   - content: *article → scroll → newsletter sign_up*

   You pick the journey you're about to take.
3. You browse. Captured GA4 events tick off the checklist live, and the toolbar extension icon badge always displays the running count of captured tags so you know right away if network requests are being noted.
4. You press **Stop**, then preview the minimized, redacted JSON and confirm sending it.
5. You get an audit report covering missing events, missing or wrong parameters, duplicates, PII leaks, and consent issues. You can export it as Markdown or JSON.

### MVP boundaries

| In the MVP | Cut and moved to the backlog (§9) |
|---|---|
| GA4, including server-side GTM / first-party endpoints | All other vendors |
| Capture with `webRequest` + live toolbar icon badge count | `dataLayer` observer |
| 4 LLM adapters: Anthropic, OpenAI, Gemini, OpenAI-compatible | — |
| Planner with a manual **Re-plan** button | Automatic re-plan |
| Pick or deselect journeys and steps from the plan | Custom user-defined expected events |
| Universal + plan-driven rules, plus the e-commerce value check | Lead-gen and content rule packs |
| API key in `chrome.storage.local`, with a warning | Passphrase-encrypted key storage |
| Markdown and JSON export | PDF export, session history |
| Unpacked or unlisted Web Store build, for pilot users | Licensing, €25 paywall, public listing |
| Single tab | Multi-tab journeys |

### The 7 sub-tasks

| # | Sub-task | Delivers | Done when | Depends on | Status |
|---|---|---|---|---|---|
| **T0** | **Repo setup** | Git repo with origin `https://github.com/eddiejaques/intellitrack.git`, `main` branch, `.gitignore`, README, this plan committed. Workflow: one branch per sub-task or backlog item (`t1-capture`, `b1-google-ads`, ...), merged to `main` when its "Done when" passes. | `main` is pushed to origin and contains `plan.md` | — | Repo initialized |
| **T1** | **Skeleton + GA4 capture** | MV3 scaffold, `webRequest` listener with `requestBody`, GA4 matcher and parser (batched bodies, sGTM hosts), events saved to IndexedDB as they arrive, popup with Start/Stop, live count, and step markers, raw session viewer, the first recorded fixtures | Captured events match GA4 DebugView at ≥ 99% on 3 real sites (e-commerce, lead-gen, publisher), including a long checkout during which the service worker is suspended | — | Code complete (16 unit tests pass); real-site DebugView gate not yet run |
| **T2** | **Minimize + rules + preview** | Noise and duplicate removal, PII redaction that keeps the value's shape, universal and plan-driven rules, e-commerce value check, preview of what will be sent, JSON export | The rules alone flag the seeded-fault fixtures correctly (using a hand-written plan). The preview contains no raw PII. | T1 | Code complete (synthetic fixtures; recorded real-site fixtures pending from T1 gate) |
| **T3** | **LLM layer** | Options page (provider, base URL, model, key, call budget), 4 thin adapters, Test connection, JSON Schema validation with one retry, runtime host permission for custom base URLs | Test connection passes on all 4 providers. An invalid response triggers the retry, then a clean failure. | — (in parallel with T1/T2) | Code complete (all 4 adapters tested against mocked endpoints; live Test connection not yet run with real keys) |
| **T4** | **Journey planner + live checklist** | Page-context extractor, `plan_v1` prompt, `journey_plan` schema, per-site consent prompt, journey picker, local live matching, Re-plan button, call-budget enforcement | The plan picks the right site type and sensible GA4 events for the e-commerce, lead-gen, and content fixtures on at least 3 of the 4 providers | T1, T3 | Code complete (unit-tested with mocked LLM); gate not run: needs live providers and real sites |
| **T5** | **Audit + report** | `audit_v1` prompt, evidence-ID check, report page (score, journey coverage, findings by severity, rule vs LLM source), Markdown export, eval script that runs every fixture against every provider | Seeded faults are found on every provider. No finding cites an event ID that isn't in the payload. | T2, T3, T4 | Code complete (`npm run eval -- --mock` passes all gates against the offline oracle); gate not run: needs live providers |
| **T6** | **Toolbar badge counter** | Live tag counter on the extension toolbar icon (`chrome.action.setBadgeText` / `setBadgeBackgroundColor`), scoped to the recorded tab, incrementing as normalized events are stored, persisting across service-worker restarts via `chrome.storage.session`, and resetting on new session or clear | Badge immediately reflects the exact count of captured tags during browsing, survives service-worker suspension, and stays blank/cleared on unrecorded tabs | T1 | Code complete (unit-tested); not yet checked in Chrome on a real tab |

```
T1 ──► T2 ──────────┐
 │                  ▼
 ├──► T4 ◄── T3 ──► T5
 │
 └──► T6
```

T2 on its own already gives a useful audit without an LLM. That makes a good fallback demo if the LLM work runs late.

---

## 2. Architecture

```
┌──────────────────────────── Chrome ─────────────────────────────┐
│  Content script: page-context extractor (title, meta, schema    │
│    types, form field types, nav labels)                         │
│                                                                 │
│  Service worker                                                 │
│   - chrome.webRequest observer (capture)                        │
│   - vendor matchers → normalized events → IndexedDB             │
│   - chrome.action badge updater (live captured tag count)       │
│   - planner (LLM Phase A) + live plan matcher (local)           │
│   - minimizer, redactor, rule engine                            │
│   - LLM adapters → fetch() to the user's endpoint               │
│  Popup:   Start/Stop, journey picker, live checklist, markers   │
│  Options: LLM config, call budget, per-site consent             │
│  Report:  preview-before-send, audit report, export             │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Capture & Toolbar Badge (T1, T6)

- **`webRequest.onBeforeRequest`** with `requestBody`, non-blocking. It gives the full URL and POST body, including batched GA4 hits sent by `sendBeacon` (type `ping`). Non-blocking observation is fully supported in MV3.
- **`onCompleted` / `onErrorOccurred`**, joined by `requestId`, give the status code and blocked hits (`net::ERR_BLOCKED_BY_CLIENT`).
- **Listeners register at the top level** of the service worker so events wake it up. Every event is written to IndexedDB immediately. Session state lives in `chrome.storage.session`.
- **`requestBody.raw`** can arrive as several byte chunks, which must be concatenated before decoding.
- **Worker-originated hits** (`tabId = -1`) are attributed to the recorded tab by their initiator origin.
- **Toolbar icon badge (T6):** Every time normalized events are persisted for the active recording session, the service worker updates the extension toolbar icon badge (`chrome.action.setBadgeText({ tabId, text: String(count) })` and `chrome.action.setBadgeBackgroundColor`) with the running total of captured tags. The count is stored in `chrome.storage.session` so it recovers immediately if the MV3 service worker wakes from suspension, and is cleared when a new session starts or the recording is reset.
- **Permissions:** `webRequest`, `storage`, `scripting`, `activeTab`, and `host_permissions: <all_urls>`. The last is needed because sGTM endpoints can be on any first-party domain. (`chrome.action` requires the `"action": {}` manifest key, no extra permission.)

---

## 4. Vendor plugin interface and GA4 (T1)

```ts
interface VendorMatcher {
  id: string;                         // "ga4", "braze", ...
  label: string;
  kind: "analytics" | "ads" | "cdp" | "engagement" | "personalization";
  match(req: RawRequest): boolean;    // match on params, not only the host
  parse(req: RawRequest): NormalizedEvent[];  // one request → N events
  piiPolicy: "never" | "hashed_only" | "expected";  // drives the PII rule (§7)
}
```

Adding a vendor means adding one file in `src/vendors/` plus parser fixtures. Nothing else changes, and every vendor item in the backlog depends on this.

**GA4 matcher:** path ends in `/g/collect`, `v=2`, `tid=G-*`, on any host (to catch sGTM). The body splits on `\n` into one event per line, with the URL params shared by all of them. Parse `en`, `ep.*` / `epn.*` into params, `pr1..prN` into items, plus `cid`, `uid`, `gcs`, `gcd`, `dl`, `dt`.

**Normalized event:**

```json
{
  "id": "evt_0042",
  "t": 18.42,
  "vendor": "ga4",
  "property": "G-ABC123",
  "event": "add_to_cart",
  "page": { "path": "/products/:id", "title": "Blue Shirt", "step": "S2" },
  "params": { "currency": "EUR", "value": 29.9 },
  "items": [{ "item_id": "SKU1", "item_name": "Blue Shirt", "price": 29.9, "quantity": 1 }],
  "user": { "client_id": "[present]", "user_id": "[absent]" },
  "consent": { "gcs": "G111" },
  "transport": { "type": "ping", "method": "POST", "status": 204 },
  "raw_ref": "req_0017"
}
```

---

## 5. Minimization and redaction (T2)

Steps, in order:

1. Filter to the selected vendors.
2. Drop noise: count `user_engagement` and similar heartbeat events instead of sending each one, drop retries, and strip cache-busters (`_z`, `_p`, `_s`).
3. Remove duplicates: same event and params within ±500 ms.
4. Replace page paths with indexes, and replace IDs in paths with `:id`.
5. Redact PII but keep its shape:
   - plaintext email → `[email:plaintext]`
   - SHA-256 → `[sha256:64hex]`; bad hash → `[hash:invalid len=40]`
   - phone → `[phone:plaintext]`
   - URL query strings dropped (allow-list in Options)
   - `client_id` → `[present]`, plus a flag for whether it stays the same across the session
6. Attach the rule findings (§7).
7. Enforce the token budget: collapse repeated identical events into `{event, count, sample}`.

Raw data never leaves the browser. The preview shows exactly what will be sent.

---

## 6. LLM layer (T3, T4, T5)

### Config (Options page)

```json
{
  "provider": "anthropic | openai | gemini | openai_compatible",
  "base_url": "https://api.anthropic.com",
  "model": "…",
  "api_key": "…",
  "max_output_tokens": 4000,
  "timeout_s": 120,
  "plan_call_budget": { "max_per_session": 5, "min_interval_s": 30 }
}
```

- `openai_compatible` covers LiteLLM, OpenRouter, Azure OpenAI, corporate gateways, and Ollama.
- **Custom `base_url`:** the extension requests `optional_host_permissions` for that origin at save time. Once granted, the service worker's `fetch` isn't blocked by CORS.
- **Anthropic:** add the `anthropic-dangerous-direct-browser-access: true` header.
- **Key storage in the MVP:** `chrome.storage.local`, unencrypted, with a visible warning to use a dedicated key with a spending cap. Never `storage.sync`, never in a content script. Encryption is backlog item B4.

### Adapter

```ts
interface LLMProvider {
  complete(req: { system: string; user: string; jsonSchema: object }): Promise<string>;
}
```

Adapters only translate request and response shapes. Each uses the provider's native JSON or structured-output mode where it exists, otherwise "return only JSON". **No adapter contains prompt logic.**

### Two phases

| Phase | When | Input | Output |
|---|---|---|---|
| **A. Plan** (T4) | First page load after Start, and the Re-plan button | Page context | `journey_plan` |
| **B. Audit** (T5) | After Stop and confirming the preview | Minimized session + confirmed plan + rule findings | Audit report |

**Page context (Phase A), no PII:**
- domain, path pattern, `<title>`, meta description, `og:type`
- schema.org `@type` values
- whether forms are present and their field *types*
- headings and main nav labels (truncated)
- vendors and IDs detected so far

**Consent:** the first time the extension records on a site, it asks whether page info may go to the configured provider: *Always for this site*, *Ask each time*, or *Never*. With *Never*, the user picks the site type by hand.

**`journey_plan` (abridged):**

```json
{
  "site_type": "lead_generation",
  "confidence": 0.8,
  "rationale": "B2B SaaS: pricing page, demo-request form, no cart",
  "journeys": [{
    "id": "J1", "name": "Demo request",
    "steps": [
      { "id": "S1", "name": "Landing",     "page_hint": "/",     "expect": [{ "vendor": "ga4", "event": "page_view" }] },
      { "id": "S2", "name": "Form start",  "page_hint": "/demo", "expect": [{ "vendor": "ga4", "event": "form_start" }] },
      { "id": "S3", "name": "Form submit", "page_hint": "/demo", "expect": [{ "vendor": "ga4", "event": "generate_lead", "params": ["value", "currency"] }] }
    ]
  }],
  "global_expectations": ["consent signals on all Google hits", "no PII in any payload"]
}
```

The confirmed plan is **the yardstick for the whole session**: the live checklist, the plan-driven rules, and the audit all measure against it. The report shows it so readers can see what the audit was measured against.

**Audit output (abridged):**

```json
{
  "summary": { "score": 0, "headline": "string" },
  "journey_coverage": [{ "step": "S3", "expected": ["generate_lead"], "observed": [], "status": "missing" }],
  "findings": [{
    "id": "F1", "severity": "critical|high|medium|low|info", "vendor": "ga4",
    "category": "missing_event|missing_param|wrong_value|duplicate|consent|pii|naming|cross_vendor_mismatch",
    "title": "string", "detail": "string", "evidence": ["evt_0091"],
    "recommendation": "string", "source": "rule|llm"
  }],
  "model": { "provider": "…", "model": "…", "prompt_version": "audit_v1" }
}
```

### Prompt rules (these keep the app LLM-agnostic)

- There are two versioned prompts, `plan_v1.md` and `audit_v1.md`. Each is a single request with a single JSON response. No tool calling, vision, or chat history.
- **The model's own knowledge is the spec source in the MVP.** We send no reference specs. Its knowledge is captured once in the `journey_plan`, which the user confirms.
- The model is told to **confirm, explain, and extend the rule findings, not contradict them without evidence**.
- Every finding must cite event IDs. Findings that cite IDs not in the payload are dropped.
- Responses are schema-validated, with one retry that includes the validation error. If that fails, the report falls back to the rules only, labeled "LLM review failed".

---

## 7. Rule engine (T2)

These rules run locally with no LLM.

**Universal**
- PII that breaks the vendor's `piiPolicy`.
- Consent signals (`gcs`/`gcd`) missing or inconsistent.
- `client_id` or measurement ID changes mid-session, or an unexpected second GA4 property appears.
- Duplicate conversions (same event and same ID, e.g. when a thank-you page is reloaded).
- Failed or blocked hits.

**Plan-driven** (works for any site type)
- Each `expect` for the steps reached is reported as matched, missing, or partial (event present but listed params missing).
- Events fired out of the plan's step order.

**E-commerce pack (MVP):**
- `value` ≈ Σ(`price` × `quantity`)
- `transaction_id` present on purchase
- `items[]` consistent from cart to purchase

---

## 8. Privacy

- Recording covers only the tab where the user pressed Start. It is never always-on.
- Sessions are stored locally in IndexedDB and purged after 30 days by default.
- Phase A data is sent according to the per-site consent setting. Phase B data is sent only after the user confirms the preview.
- No telemetry or analytics from us. Data goes only to the user's own endpoint.

---

## 9. Backlog (Kanban, prioritized)

### Board

| Column | Rule |
|---|---|
| **Backlog** | Ordered by the table below. Only the top is refined. |
| **Ready** | Has acceptance criteria and fixtures (real captured requests for vendor items). Max 3 items. |
| **In progress** | WIP limit 2. |
| **Review / Eval** | Parser tests pass, and the eval script (T5) shows no regression on the existing fixtures. |
| **Done** | Merged and released to pilot users. |

The MVP task statuses are tracked in §1. Create `kanban.md` when work resumes to track the MVP and backlog together.

Always pull from the top of Ready. **Triggered** items skip the queue only when their trigger fires.

### Prioritization

The order weighs audit value for pilot users, risk reduction, and readiness for launch against effort. Size: S ≈ ≤ 2 days, M ≈ 3–5 days, L ≈ 1–2 weeks. These are rough estimates, to re-size when each item is refined.

| Prio | ID | Item | Type | Size | Why at this position | Depends on |
|---|---|---|---|---|---|---|
| 1 | B28 | **Vendor selection** (plan §5 "filter to the selected vendors"): choose GA4 and/or Google Ads per session in the popup, live log and audit preview; GA4 is the default; every vendor is still captured | feature | S | The MVP promised the ability to select vendors, GA4 only to start. B1 added a second vendor, so the choice has to exist. | B1 |
| 2 | B27 | **Live visibility and session management** (bug, found on a real shop): record every tag-like request, parsed or not; GA4 on custom server-side paths; side panel with live count and raw tag tables; Sessions history grouped by site, each session with its own log, plan and report; one journey audited by default; empty sessions are inconclusive instead of a wall of failures | bug | M | Reported from a real recording: nothing visible while browsing, no way to inspect raw tags, three tests looked like one blur, and an empty capture produced 19 findings. | MVP |
| 3 | B26 | **UI design pass** (shared design system: tokens, light/dark, type scale, icons; popup, settings, preview, report, raw viewer; toolbar icons) | UI | M | The MVP UI grew by task and is cluttered. Pilot users judge the product by what they see first, and designers are an early audience. | MVP |
| 4 | B1 | **Google Ads conversion + enhanced conversions** | vendor | M | The most-requested check after GA4. Unlocks the first cross-vendor check (GA4 purchase value vs Ads conversion value) and the hashing check. | MVP |
| 5 | B2 | **`dataLayer` observer** (MAIN world) | capture | M | Finds "pushed but never sent", which is the most common cause of GTM bugs. Benefits every vendor. | MVP |
| 6 | B3 | **Lead-gen rule pack** | rules | S | Lead-gen is the second most common site type. Cheap once the plan-driven rules exist. | MVP |
| 7 | B4 | **Passphrase-encrypted key storage** | security | S | Required before any public listing. | MVP |
| 8 | B5 | **Meta Pixel** | vendor | S | Widely used. `eventID` dedup with CAPI is a frequent fault. | MVP |
| 9 | B6 | **Floodlight / CM360** | vendor | S | Enterprise and agency demand. Simple URL parsing. | MVP |
| 10 | B7 | **Licensing + paywall + public Web Store listing** (€25, Lemon Squeezy/Paddle/Gumroad, offline Ed25519 key, free tier = GA4 + rule report) | business | M | Starts revenue once the vendor set justifies €25. | B4 |
| 11 | B8 | **Braze Web SDK** | vendor | M | First engagement-platform vendor. Introduces `piiPolicy: expected` and identity-timing checks (`changeUser` at login or signup). | MVP |
| 12 | B9 | **Salesforce Marketing Cloud Personalization** (Interaction Studio / Evergage) | vendor | M | Most common Salesforce web tag in e-commerce. | B8 (reuses identity checks) |
| 13 | B10 | **Salesforce Data Cloud Web SDK** | vendor | M | Consent and identity event ordering. | B8 |
| 14 | B11 | **Segment** | vendor | M | CDP. `identify` → `track` ordering; Segment Spec. | MVP |
| 15 | B12 | **Mixpanel** | vendor | S | Product analytics. `distinct_id` stability. | MVP |
| 16 | B13 | **Multi-tab journeys** (payment pop-ups, 3-D Secure) | capture | M | Checkouts that open a new tab currently lose their purchase events. (Tabs opened *from* the recorded tab are now followed automatically; this item covers the rest, e.g. tabs the user opens by hand.) | MVP |
| 17 | B14 | **Content rule pack** | rules | S | Publisher sites. | MVP |
| 18 | B15 | **Salesforce Account Engagement (Pardot)** | vendor | S | B2B lead-gen sites. | B8, B3 |
| 19 | B16 | **Salesforce Marketing Cloud Engagement (Collect.js)** | vendor | S | Legacy, but still widespread. | B8 |
| 20 | B17 | **HubSpot, Klaviyo** | vendor | M | Engagement platforms for SMB and DTC. | B8 |
| 21 | B18 | **Amplitude, RudderStack** | vendor | M | Product analytics and CDP. | B11 |
| 22 | B19 | **Auto re-plan suggestion** | planner | S | Nicer UX for long journeys across sections. | MVP |
| 23 | B20 | **User specification as the audit yardstick** (upload or paste a list of requirements per site; each checked as pass / fail / not tested) | planner | L | For teams with their own tracking plan: the audit checks their requirements, not only ours. | X1 |
| 24 | B21 | **TikTok, LinkedIn Insight, Pinterest, Bing UET, Snap** | vendor | M | Long tail of ad pixels. One shared parser pattern. | B5 |
| 25 | B22 | **Adobe Analytics / Web SDK (AEP Edge)** | vendor | L | Enterprise. Complex XDM / eVar mapping. | B2 |
| 26 | B23 | **PDF export + session history** | UI | M | Agencies hand reports to clients. | MVP |
| 27 | B24 | **Universal Analytics leftovers flag** | vendor | S | Quick win: flags dead UA tags still firing. Can be pulled in any time there's slack. | MVP |
| 28 | B25 | **Safari port** (App Store, MAIN-world capture, Keychain, native messaging) | platform | L | Second platform. Lets Apple charge the €25 on the App Store instead of us running license keys. | B2, B7 |
| — | T-1 | **Move B2 into the MVP** | triggered | — | **Trigger:** T1's ≥ 99% capture gate fails. | — |
| — | T-2 | **Reference specs in `shared/specs/`**, injected into prompts | triggered | M | **Trigger:** the T5 eval shows providers' plans disagree on the same fixture. | T5 |
| — | T-3 | **Reprioritize B8–B10 against B1–B6** | triggered | — | **Trigger:** pilot users run Braze or Salesforce rather than Google Ads or Meta. | — |

---

## 10. Vendor integration notes (for backlog vendor items)

Patterns marked **†** are from memory. Confirm each against a live capture when the item moves to Ready. That confirmation is part of the Ready criteria.

| Vendor | `kind` | Detection (indicative) | `piiPolicy` | Audit angle |
|---|---|---|---|---|
| Google Ads conversion / EC | ads | `googleadservices.com/pagead/conversion/*`, `google.com/pagead/1p-conversion/*` | hashed_only | fires once per conversion; value and currency match GA4; EC values are SHA-256 of normalized input |
| Floodlight / CM360 | ads | `*.fls.doubleclick.net/activity*`, `ad.doubleclick.net/activity*` | never | `type`/`cat` correct; `ord` unique per conversion |
| Meta Pixel | ads | `facebook.com/tr` | hashed_only | `eventID` present for CAPI dedup; `Purchase` value and currency |
| **Braze** Web SDK | engagement | POST `sdk.*.braze.com/api/v3/data/` (JSON, batched) † | expected | `changeUser(external_id)` at login or signup; no `external_id` churn; custom events and attributes match the plan |
| **Salesforce MC Personalization** | personalization | `*.evergage.com/api2/event/*` † | expected | identity set at login; catalog/product events on PDP |
| **Salesforce Data Cloud** | cdp | `*.c360a.salesforce.com/web/events/*` † | expected | consent event before engagement events; identity at signup |
| **Salesforce Account Engagement** | engagement | `pi.pardot.com/analytics*`, `go.pardot.com` † | expected | visitor tracking on form pages; form handler fires on submit |
| **Salesforce MC Engagement** (Collect.js) | engagement | `*.collect.igodigital.com/*` † | expected | `trackPageView` / `trackCart` / `trackConversion` present |
| Segment | cdp | `api.segment.io/v1/{t,p,i,batch}` + proxy host | expected (on `identify`) | `identify` before `track`; follows the Segment Spec |
| Mixpanel | analytics | `api*.mixpanel.com/{track,engage}` (base64 `data`) | never | `distinct_id` stable |
| Amplitude | analytics | `api2.amplitude.com/2/httpapi`, `api.eu.amplitude.com` † | never | `user_id` / `device_id` consistency |
| RudderStack | cdp | `*/v1/{track,page,identify,batch}` on the data-plane host † | expected | same checks as Segment |
| HubSpot | engagement | `track.hubspot.com/__ptq.gif`, `forms.hubspot.com` † | expected | form submission tracked; `hutk` present |
| Klaviyo | engagement | `a.klaviyo.com/api/track`, `/client/events` † | expected | `Viewed Product`, `Started Checkout` |
| Adobe Analytics / AEP Edge | analytics | `*/b/ss/*`; `*/ee/*/v1/interact` † | never | XDM shape; `eVar`/`prop` mapping |

**Status of vendor notes:** B1 (Google Ads) is implemented from Google's documented gtag conversion ping (`label`, `value`, `currency_code`, `oid`; enhanced-conversion identifiers are detected by what they contain, not by parameter name). Its tests use synthetic URLs. Before B1 is Done, replace them with real captured pings (direct, first-party `1p-conversion`, and an enhanced-conversions purchase) and confirm the parameter names.

**Why `piiPolicy` matters for Braze and Salesforce:** these platforms are *meant* to receive identity such as an email or `external_id`. Flagging a plaintext email sent to them would be a false positive. For these vendors, the audit checks that identity is set at the right moment and stays stable, not that it's absent. Data is still redacted before it reaches the LLM. The LLM sees `[email:plaintext]`, and the vendor's policy tells it whether that's acceptable.

---

## 11. Repo layout

TypeScript, esbuild, `idb`, `@anthropic-ai/sdk` (Anthropic adapter only), Vitest, Playwright. *T3 decision:* our own small JSON Schema validator instead of `ajv`, because Ajv compiles validators with `new Function`, which the MV3 extension CSP blocks. *T1 decision:* plain esbuild and plain DOM UI instead of Vite/crxjs and Preact. Three small entry points don't need a framework. Revisit if the T4/T5 UI grows. `chrome.*` is used directly; the Safari port (B25) will wrap it behind a small adapter, since the polyfill adds little in MV3.

```
intellitrack/
  extension/src/
    background/   # capture, session store, planner, LLM calls
    content/      # page-context extractor
    vendors/      # ga4.ts (MVP); one file per backlog vendor
    minimize/     # dedupe, redact, compress
    rules/        # universal, plan-driven, ecommerce pack
    llm/          # anthropic.ts, openai.ts, gemini.ts, openai_compatible.ts
    ui/           # popup, options, report
  shared/
    schemas/      # normalized-event, journey-plan, payload, audit-report
    prompts/      # plan_v1.md, audit_v1.md
  fixtures/       # recorded sessions: ecommerce, lead_gen, content (+ seeded faults)
  scripts/eval.ts # runs fixtures against every configured provider
```

---

## 12. Testing

- **Fixtures (recorded in T1, used from T2 on):** one real journey each for e-commerce, lead-gen, and content, plus seeded-fault copies (missing `add_to_cart`, `generate_lead` on an invalid submit, plaintext email, duplicate purchase, wrong `value`).
- **Parser unit tests:** real GA4 URLs and bodies, both batched and single.
- **Planner eval (T4):** does the plan pick the right site type and the events a specialist would expect? It is scored against a hand-written plan.
- **Audit eval (T5):** seeded faults found, false positives, schema validity, and agreement between providers. Rerun whenever a prompt version or model changes, and on every backlog item in Review.
- **E2E:** Playwright with the unpacked extension, against a local mock site that fires known tags.

---

## 13. Risks

1. **The plan is the yardstick, so a wrong plan means a wrong audit.** The user confirms the plan, and the report shows it. If an audit looks wrong, check the plan first.
2. **Provider disagreement:** the same session can get a different plan on Claude than on Gemini. The T5 eval measures this. Trigger T-2 if it's high.
3. **Capture gaps:** the T1 gate (≥ 99% match with DebugView) decides this. Trigger T-1 if it fails.
4. **Web Store review** of `<all_urls>` + `webRequest`. The MVP ships unlisted, so this risk only lands with B7.
Regards,Gaurav Kumar Dani