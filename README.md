# Empty Screens

A small Node app for finding Cineplex showtimes with unusually empty reserved-seat maps.

## Run Locally

```sh
npm start
```

The app serves the frontend and API from `http://localhost:4173`.

## Environment

Copy `.env.example` into your host's environment settings and set `CINEPLEX_API_KEY` privately. The committed default is only for local MVP continuity; production should use an environment variable.

Important variables:

- `PORT`: HTTP port, default `4173`
- `NODE_ENV`: use `production` on a deployed host
- `CINEPLEX_API_KEY`: Cineplex API subscription key
- `APP_USER_AGENT`: app identifier/contact used for postal-code geocoding
- `DEFAULT_LAT` / `DEFAULT_LNG`: fallback search location
- `DEFAULT_THEATRES` / `MAX_THEATRES`: theatre search bounds
- `API_RATE_LIMIT` / `API_RATE_WINDOW_MS`: per-IP API throttling
- `UPSTREAM_CACHE_TTL_MS` / `COMPUTED_CACHE_TTL_MS`: Cineplex and result cache windows

## Deploy

Any Node 20+ host works because there are no runtime dependencies.

1. Push this folder to a private GitHub repo.
2. Create a Node service on Render, Railway, Fly.io, or a VPS.
3. Set `npm start` as the start command.
4. Set the environment variables from `.env.example`.
5. Point your subdomain DNS to the host.

For a subdomain like `empty.yoursite.com`, create a `CNAME` record if your host gives you a hostname, or an `A` record if your host gives you an IP. Add the same domain in the host dashboard so TLS can be issued.

## Production Notes

- `/healthz` returns a lightweight health check.
- Static files use security headers and cache headers.
- API calls are rate-limited, timed out, cached, and coalesced.
- User inputs are validated before calling upstream APIs.
