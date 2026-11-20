# Releasing IntelliTrack

Each release is one command and one push. The version lives only in `package.json`, and the build stamps it into the extension's manifest. Pushing a `vX.Y.Z` tag starts `.github/workflows/release.yml`, which:

1. runs the typecheck, tests and build;
2. fails if the tag doesn't match the manifest version;
3. packages `release/intellitrack-X.Y.Z.zip` and checks it (manifest at the root, MV3, icons present, no source maps, tests or remote code);
4. runs the real-Chrome smoke test against that exact zip;
5. creates a GitHub Release with the zip and the CHANGELOG entry as notes;
6. uploads the zip to the Chrome Web Store and submits it for publishing.

The MVP is **Unlisted**: pilot users install it from the store link and get updates automatically. Listing text, permission justifications and privacy answers are in [store-listing.md](store-listing.md).

## One-time setup (the PM, by hand)

The agent can't do these, because they need your Google account. Do them **after the X9 pull request is merged**, because step 2 needs `npm run package` on `main`. Merging doesn't depend on this setup: without the secrets, the pipeline skips the store step. Steps 1 to 4 happen in the browser.

1. **Developer account.** Sign in at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) with the Google account that will own IntelliTrack, and pay the one-time $5 registration fee. Turn on **2-step verification** for that account, because the API requires it.

2. **First upload, by hand.** The API can only update an item that already exists.
   - In the main checkout, on an up-to-date `main`, run `npm run package`. It creates `release/intellitrack-0.1.0.zip`.
   - In the dashboard: **New item**, then upload that zip.
   - Fill in the **Store listing** and **Privacy** tabs from [store-listing.md](store-listing.md), and add the screenshots and promo tile.
   - Under **Distribution**, set visibility to **Unlisted**.
   - Submit it for review. **Wait until this first review is finished** before you tag 0.2.0. See *Review timing*.
   - Note two values. The **extension ID** (32 letters) is on the item's page. The **publisher ID** is under **Publisher > Settings** (Account) in the dashboard.

3. **API access** (Google Cloud Console):
   1. Create or pick a project, open *APIs & Services > Library*, and enable the **Chrome Web Store API**.
   2. *OAuth consent screen*: choose **External**, fill in the app name and the two emails, skip scopes, and add your own email under **Test users**.
   3. *Credentials > Create credentials > OAuth client ID*, application type **Web application**. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI. Note the client ID and client secret.
   4. Get a refresh token:
      - Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground). In its settings (gear icon), tick **Use your own OAuth credentials** and enter the client ID and secret.
      - Enter the scope `https://www.googleapis.com/auth/chromewebstore` and click **Authorize APIs**, signing in as the account that owns the item.
      - Click **Exchange authorization code for tokens** and copy the **refresh token**.
      - Note that while the consent screen is in *Testing*, Google may expire refresh tokens after 7 days. Publish the consent screen (it is used only by you) so the token lasts.

4. **Secrets in GitHub.** In the repo, go to *Settings > Secrets and variables > Actions > New repository secret* and add all five:

   | Secret | Value |
   |---|---|
   | `CWS_PUBLISHER_ID` | publisher ID from step 2 |
   | `CWS_EXTENSION_ID` | extension ID from step 2 |
   | `CWS_CLIENT_ID` | OAuth client ID from step 3 |
   | `CWS_CLIENT_SECRET` | OAuth client secret from step 3 |
   | `CWS_REFRESH_TOKEN` | refresh token from step 3 |

   The values only ever go into GitHub's secret store. Never put them in a file, a commit, an issue or a comment. The agent can check that the secrets exist (`gh secret list` shows names, not values).

Until all five secrets are set, the pipeline still creates the GitHub Release with the zip, and the store step is skipped with a notice. You can upload that zip by hand.

## Each release

In the main checkout, on an up-to-date `main`:

```bash
npm run release -- minor        # or patch / major
git push origin main --follow-tags
```

`npm run release`:

- refuses if there are uncommitted changes, you aren't on `main`, or `main` isn't exactly `origin/main`;
- bumps the version in `package.json`;
- adds a dated `CHANGELOG.md` entry that lists the cards (PR titles) merged since the last tag;
- commits `Release vX.Y.Z` and creates the annotated tag `vX.Y.Z`.

It never pushes. The push sends the commit and the tag together, and the tag starts the pipeline.

To write the release notes yourself, add a `## X.Y.Z (unreleased)` section to `CHANGELOG.md` and merge it before you run the release. The command keeps your text and only fills in the date.

**The first release is 0.2.0.** `CHANGELOG.md` already has a hand-written `0.2.0 (unreleased)` entry covering the MVP, B1 and B26–B28. In order:

1. Add any cards merged since then (for example B2) to that entry. Commit the change and push it to `main`. `npm run release` refuses a dirty tree or a `main` that isn't exactly `origin/main`.
2. Run `npm run release -- minor`. It dates the entry, sets the version to 0.2.0, commits and tags.
3. **Before you push**, run the smoke test on the zip that CI will test, once on your machine. The CI e2e step hasn't been seen running yet, and the first tag is its first run:
   ```bash
   npm run package && npm run e2e -- --from-zip release/intellitrack-0.2.0.zip
   ```
4. `git push origin main --follow-tags`.

If the CI e2e step fails on that first run for reasons of the CI machine rather than the extension (for example no Chrome there), the local run in step 3 is the release check. Note it on the card so the pipeline can be fixed.

## Check the result

- **Pipeline:** the repo's *Actions* tab, under the *Release* run for the tag. The last step's log ends with the store's state, usually `PENDING_REVIEW`.
- **GitHub Release:** the repo's *Releases* page has the zip and notes.
- **Store:** the item in the Developer Dashboard shows the submitted version and its review status. Once live, `chrome://extensions` on a pilot user's machine shows the new version after Chrome's next update check. *Update* in developer mode forces it.
- **In the extension:** the popup footer and Settings show `IntelliTrack vX.Y.Z`.

## Review timing

Every upload is reviewed before it goes live. That usually takes a few days, and can take longer for broad permissions like ours (`<all_urls>` with `webRequest`, see plan §13). **The previous version stays live until the new one is approved.**

Don't tag a second release while one is still in review. A new upload replaces the pending one and restarts the review. If a release must be held back, cancel the pending submission in the dashboard instead.

If a review is rejected, the dashboard says why. Fix it, run `npm run release -- patch` and push again. A rejected or replaced upload still uses up its version number, and the store refuses an upload whose version isn't higher than the last one.
