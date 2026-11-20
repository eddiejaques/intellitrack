# IntelliTrack workflows

Step-by-step guides for the things people actually do with IntelliTrack. For installation see the [README](../README.md#install).

## First-time setup: connect your LLM

Skip this if you only want rule-based audits.

1. Click the toolbar icon, then **⚙** (or the *Set up →* link under the Start button).
2. Choose a provider:

   | Provider | Base URL | Model |
   |---|---|---|
   | Anthropic (Claude) | `https://api.anthropic.com` | e.g. `claude-sonnet-5-5` |
   | OpenAI | `https://api.openai.com` | a model ID from your account |
   | Google Gemini | `https://generativelanguage.googleapis.com` | a Gemini model ID |
   | OpenAI-compatible (LiteLLM, OpenRouter, Azure, Ollama, a company gateway) | your gateway URL | the model name it expects |

3. Paste your API key (not needed for a local Ollama), press **Test connection**, then **Save**.
4. Use a dedicated key with a spending cap: it is stored unencrypted in your browser.

*Limits & budget* (collapsed by default) sets max output tokens, timeout, and how many journey-planning calls a session may make.

---

## 1. Audit a journey with your LLM

1. Open the site in a normal tab and go to the page where the journey starts (for a shop: a product page).
2. Open IntelliTrack → **Start recording**. The live side panel opens.
3. **First time on this site:** IntelliTrack asks whether page *structure* may be sent to your LLM to propose a journey. *Always for this site*, *Ask each time* (you see the JSON first) or *Never* (you pick the site type yourself).
4. A **journey plan** appears: the steps a visitor takes and the GA4 events expected at each. Only the first journey is selected by default. Switch journeys or steps on and off with the toggles. **Re-plan** asks again (rate-limited by your budget).
5. **Do the journey for real.** Accept the cookie banner, open a product, add to cart, start checkout. As each expected event arrives its step ticks in the popup.
6. Optionally press **Mark** on a step when you start it. This ties the events that follow to that step, which makes "missing at step X" findings precise.
7. Press **Stop recording**.
8. Open **Sessions** (popup → *Sessions*) and click **Run LLM audit** on your session.
9. On the preview page, check the findings the rules already found, the journey coverage, the **privacy check** and the payload. Make sure *Vendors in this audit* is what you want.
10. **Confirm & send to my LLM.** The report opens: a score, a headline, journey coverage and findings grouped by severity. Each finding is tagged **rule** or **LLM**, cites the events it is about, and says how to fix it.

How to read the report:
- Findings that cite an event that does not exist are discarded automatically (the report tells you how many).
- An LLM can *confirm* a rule finding or flag it as *needs context*. It can only *dispute* one by pointing at specific events, otherwise the rule finding stands.
- The score is computed locally from the findings, so the same findings always give the same score.
- If the LLM call fails, you still get the rule findings, labelled "LLM review failed".

## 2. Quick check with no LLM

1. Record as above (skip the LLM setup; choose the site type by hand when asked).
2. **Sessions → Log** to inspect tags, or open the audit preview.
3. Press **Rules-only report (nothing sent)**.

Nothing leaves your browser. Rules catch the mechanical problems (missing or duplicated events, wrong `value`, missing `transaction_id` or currency, plaintext email/phone, missing consent signals, failed hits). The LLM adds judgement, for example a conversion that fired when your step said the form was invalid.

## 3. Compare several sessions or sites

Every recording is its own **session**, kept separately with its own tags, plan and report.

- **Sessions** lists them grouped by site. Each row shows when it ran, how long, events per vendor, tag requests, how many were not parsed, and the audit status or score.
- Record the same site again after a fix and compare the two scores and reports side by side.
- Record different sites (or different journeys on one site) without anything blending together.
- **Log**, **Report** and **Run/Re-audit** always act on the session you clicked. **Delete** removes only that session's data.

## 4. Debug a site that shows no events

The **Tags** tab of the live panel / session log lists *every* tag-like request, including ones IntelliTrack cannot parse.

1. Start recording **before** you interact, and keep browsing for 30 seconds or so.
2. Open the **Tags** tab. Turn on **Not parsed only**.
3. Read what you see (a banner appears if tag hits came from a worker or another context and could not be tied to this tab):
   - **Nothing at all:** many European sites fire analytics only after you accept cookies. Accept the banner and click around. Also check that an ad blocker or privacy extension is not blocking requests.
   - **Rows labelled `not parsed · <vendor>`:** the site uses a vendor IntelliTrack does not audit yet (Meta, TikTok, Criteo, Bing, ...). They are shown raw so you can still inspect them. Click a row for the full URL, decoded query parameters and body.
   - **`not parsed · Universal Analytics (legacy)`:** the site still sends old UA hits instead of GA4.
   - **GA4 requests that are not recognised:** use **Export JSON** in the session log and open an issue with the file. Server-side setups that rename or obfuscate the path can look different.
4. If a session captured nothing, its report is *inconclusive*: no score, no LLM call, and a short checklist instead of a wall of "missing" findings.

## 5. Choose which vendors to audit

Every vendor is always **captured**. The vendor pills decide what is **counted, listed in Events, audited and sent**.

- **GA4** is on by default; **Google Ads** is opt-in.
- Toggle the pills in the popup (also sets the default for new sessions), above the tables in the live panel and session log, or in the audit preview.
- Leave Google Ads out and the audit ignores Ads events and the GA4-vs-Ads cross-checks. Include both to compare purchase value, currency and transaction ID between GA4 and the Ads conversion.
- A vendor left out stays visible in the Tags tab, muted, with *(left out)*.

## 6. Share a result

- **Report → Export Markdown** gives a readable file for tickets and docs. **Export JSON** gives the full structured report.
- **Session log → Export JSON** exports the raw session (events and every tag request). Attach this when reporting a capture problem. It contains the URLs and bodies of tag requests from your browsing, so review it before sharing.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| A page says **"IntelliTrack was updated, but it is still running the old version"** | You rebuilt the extension. Open `chrome://extensions`, click reload on IntelliTrack, reopen the page. Sessions are kept. |
| The count stops growing after you click a product | The site opened it in a **new tab**. IntelliTrack follows tabs opened from the recorded tab (the session log shows *N tabs*), so reload the extension if this build is new. Tabs you open yourself are not followed: click the link on the recorded page instead. |
| Count stays at 0 | No tags yet, or the site waits for cookie consent. See [workflow 4](#4-debug-a-site-that-shows-no-events). Check the vendor pills: a vendor that is left out is not counted. |
| Count is lower than the number of tag requests | Requests IntelliTrack cannot parse count as *tag requests*, not *events*. Look for the *not parsed* chip. |
| **Confirm & send to my LLM** is greyed out | No LLM configured, the session has no events for the chosen vendors, or the privacy check found raw personal data. The page says which. |
| Report says **LLM review failed** | Auth error, wrong model name, timeout or a model that did not return valid JSON twice. The message shows the reason; the rule findings are still valid. |
| Test connection fails with a CORS or network error | Check the base URL (no trailing path other than the provider's), and that the gateway allows browser requests. |
| Side panel does not open | Needs Chrome 116+. Use **Live panel** in the popup, or **Sessions → Log** for the same tables in a tab. |
| A site blocks automated browsers | IntelliTrack works in your normal, logged-in browser; automated browsers often get a bot check instead of the real page. |
