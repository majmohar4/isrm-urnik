# Security policy

## Supported deployment

IŠRM is intended to run behind HTTPS at `https://isrm.majmohar.eu`. The Android app accepts only encrypted HTTPS traffic. Keep the Docker service bound to loopback and expose it only through the configured reverse proxy or Cloudflared container.

Never commit `.env`, Docker volumes, signing keystores, GitHub Actions secrets, ntfy access tokens, or administrator passwords. Rotate any secret that is accidentally published.

## Android release integrity

Publish release builds using the unchanged application id `eu.majmohar.isrm` and the same release signing lineage. Direct APK downloads are signed but are still sideloaded; Android may require a user to authorize the browser as an install source. This is an Android source-safety control, not a malware verdict.

For a store-verified release, submit the signed AAB produced by `:app:exportPlayBundle` to Google Play Console and enable Play App Signing. Complete the Store listing, Data safety form, privacy-policy link, and pre-launch testing before production rollout. Google Play and Play Protect make the final determination; this project cannot suppress or bypass their warnings.

## Reporting a vulnerability

Do not publish sensitive vulnerabilities in a public issue. Contact the maintainer privately through the contact address in the deployed privacy policy, including a reproduction and impact summary. Do not include passwords, tokens, keystores, or personal student data in reports.
