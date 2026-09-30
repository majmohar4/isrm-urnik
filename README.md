# Skupni urnik

Android-first PWA that combines the supplied FRI and FMF schedules. It fetches the sources on the server, normalises their HTML into one weekly feed, caches the last successful result, and refreshes every 15 minutes.

## Run locally

```sh
npm install
npm run dev
```

In a second terminal, run the fetch/API service:

```sh
npm start
```

The Vite dev server proxies `/api` to that service.

## Docker deployment

1. Copy `.env.example` to `.env` and choose the ntfy topic for source-health alerts.
2. Start it:

```sh
docker compose up -d --build
```

The `timetable-cache` volume retains the latest successful schedule when a source is temporarily unavailable. Change source addresses through `programme-sources.json`; change ntfy notification configuration through `.env`.

The application port is deliberately bound to `127.0.0.1:${HOST_PORT}` (default `3000`). Change `HOST_PORT` in `.env` to any unused local port, then route it to `isrm.majmohar.eu` through your separate Cloudflared or reverse-proxy container. It is not directly exposed by Docker.

## Reliability and rate limits

The scraper deliberately does not try to evade rate limits. FRI is fetched once and then materialised as a recurring weekly template, while FMF is cached per week. When a user opens several uncached FMF weeks quickly, requests are queued three seconds apart instead of being rejected or sent as a burst. The fetcher identifies itself, honours `Retry-After`, uses bounded exponential backoff, then puts the source into a 30-minute cooldown. Last successful entries remain available during any outage. Source failures and recoveries publish to the configured ntfy topic.

If a source returns a page without its known timetable container, changes status, or becomes rate-limited, the source status at the bottom of the app switches to a warning and the message is shown at the top. `GET /health` returns HTTP 503 with the affected source names when a source is failing, which is appropriate for uptime monitors; `/live` is the container liveness endpoint. ntfy is called only when a source changes between healthy and unhealthy (or recovers).

## Source adapters

`server.mjs` contains separate FRI and FMF adapters. FRI allocations are recurring weekly entries. FMF is date-specific, so the server requests the Monday of the selected week and derives exact entries from its timetable box positions. Both source statuses are returned to the UI; failures retain cached data and appear visibly in the app.

## Changing programme links

Edit [programme-sources.json](programme-sources.json). Each programme year has one `friUrl` and one `fmfUrl` in one clearly labelled block. Save the file, then restart the service with:

```sh
docker compose up -d --build timetable
```

The old cached timetable remains available until the corrected source has been fetched successfully.

## Public repository checklist

- `.env`, the Docker cache volume, and generated files are ignored by Git.
- Copy `.env.example` to `.env`; never commit an ntfy access token.
- Review `programme-sources.json` before release: only FRI allocation and FMF layer HTTPS URLs are accepted by the server.
- Run `npm ci`, `npm run check`, and `docker compose up -d --build` before a release.
