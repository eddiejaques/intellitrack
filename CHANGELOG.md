# Changelog

What changed in each IntelliTrack release. Each release is a git tag `vX.Y.Z`; pushing it publishes the release (see docs/release.md).

## 0.2.0 (unreleased)

The first release for pilot users, installed from an unlisted Chrome Web Store link.

- **MVP (T0–T6):** records GA4 tags in the tab you choose (including server-side GTM and first-party endpoints), keeps sessions in the browser, plans the journey with your own LLM, checks it with a built-in rule engine, and writes an audit report. A toolbar badge counts captured tags.
- **Google Ads conversions and enhanced conversions (B1)**, with GA4-vs-Ads cross-checks on purchase value, currency and transaction ID.
- **UI design pass (B26):** shared design system with light and dark themes for the popup, side panel, preview, report, settings and raw viewer.
- **Live visibility and session management (B27):** every tag-like request is logged, parsed or not; a live side panel; session history grouped by site; empty sessions are inconclusive instead of a wall of failures.
- **Vendor selection (B28):** choose GA4 and/or Google Ads per session; every vendor is still captured.
- Detects GA4 that loads but never sends, follows tabs opened from the recorded tab, and attributes hits sent by service workers.
- The version is shown in the popup and Settings, and each release is packaged and published by a pipeline (X9).

## 0.1.0 (2026-11-19)

- First build of the GA4 audit extension, loaded unpacked from `dist/`.
