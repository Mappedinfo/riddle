# Riddle Web / PWA

The current cross-platform client for Riddle. It preserves the diary's
paper-first interaction while running in iPad Safari, Android browsers, and
desktop browsers.

## Capabilities

- Apple Pencil and stylus input through Pointer Events;
- pressure, tilt, altitude, and azimuth capture when the browser exposes them;
- coalesced event sampling for smoother strokes;
- touch suppression while a pen is active to reduce palm marks;
- 2.8-second idle submission to an OpenAI-compatible vision endpoint;
- progressive handwritten replies;
- local draft and up to 400 remembered pages in IndexedDB;
- installable PWA shell with offline access to saved pages.

## Run

```sh
npm install
npm run dev
```

The default server binds only to localhost so its credentialed oracle proxy is
not exposed to the local network. Run `npm run dev:lan` only on a trusted
network when testing from an iPad, and stop it when the test ends. For a
production deployment, serve `npm run build` output over HTTPS; service workers
and installability require HTTPS outside localhost.

On iPad, use **Share → Add to Home Screen**. Safari 18.2 or newer is recommended
for `getCoalescedEvents()`, `getPredictedEvents()`, `altitudeAngle`, and
`azimuthAngle` support.

## Oracle configuration

The repository-local `.env` uses `QWEN_API_URL`, `QWEN_AI_KEY`, and
`QWEN_API_MODEL=qwen3.8-max`. Both the Vite development server and
`npm run start` forward `/api/oracle` to Qwen without exposing the key to
browser code. Qwen receives the rendered handwritten page as an OpenAI-style
`image_url` data URL and returns both its transcription and reply.

The DeepSeek variables remain supported as a text-only fallback. In that mode,
the PWA opens an iPad Scribble-compatible transcription field before asking the
model.

If no managed DeepSeek key is configured, the settings sheet retains the
prototype path for a browser-callable OpenAI-compatible vision endpoint. That
endpoint must permit browser CORS requests.

## GitHub Pages

The Pages workflow publishes the static PWA without embedding any provider
credential. Set the repository variable `RIDDLE_ORACLE_PROXY_URL` to a public,
CORS-enabled proxy with authentication, origin checks, and rate limits before
using AI in the hosted demo. Without it, drawing,
offline installation, drafts, and local memory still work, while visitors may
configure a browser-callable endpoint for their own device.

Direct browser API keys are appropriate only for personal prototypes. A public
deployment should place the provider credential behind a same-origin server
endpoint.
