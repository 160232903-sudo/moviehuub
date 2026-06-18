/**
 * Movie Hub — Cloudflare Pages Function
 * File: /functions/api.js
 *
 * The API keys are supplied by the frontend on every request as headers:
 *   X-TMDB-Key   — the user's TMDb v3 API key (for type=tmdb requests)
 *   X-PM-Key     — the user's Premiumize API key (for type=torrentio requests)
 *
 * Keys are used ephemerally to build the upstream request and are never
 * logged, stored, or returned to the client. No environment variables needed.
 *
 * Routes:
 *   GET /api?type=tmdb&endpoint=<tmdb_path>
 *   GET /api?type=torrentio&endpoint=<torrentio_path>
 *
 * Premiumize API calls are NOT handled here — they go browser → Premiumize directly.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-TMDB-Key, X-PM-Key",
};

/**
 * Realistic Chrome-on-Windows UA so Torrentio's Cloudflare firewall
 * doesn't fingerprint the serverless worker as a bot.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function onRequest(context) {
  const { request } = context;

  // Handle CORS pre-flight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const endpoint = url.searchParams.get("endpoint");

  if (!type || !endpoint) {
    return jsonError(400, "Missing required query parameters: type, endpoint");
  }

  try {
    if (type === "tmdb") {
      return await handleTmdb(endpoint, request);
    }

    if (type === "torrentio") {
      return await handleTorrentio(endpoint, request);
    }

    return jsonError(400, `Unknown proxy type: "${type}". Use "tmdb" or "torrentio".`);
  } catch (err) {
    return jsonError(502, `Upstream request failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// TMDB — key comes from the X-TMDB-Key request header sent by the browser
// ---------------------------------------------------------------------------

async function handleTmdb(endpoint, request) {
  const apiKey = request.headers.get("X-TMDB-Key");
  if (!apiKey) {
    return jsonError(401, "X-TMDB-Key header is required for TMDB requests.");
  }

  const separator = endpoint.includes("?") ? "&" : "?";
  const upstreamUrl = `https://api.themoviedb.org/3/${endpoint}${separator}api_key=${apiKey}`;

  const upstream = await fetch(upstreamUrl, {
    headers: {
      "Accept": "application/json",
      "User-Agent": BROWSER_UA,
    },
    cf: { cacheTtl: 300 },
  });

  const body = await upstream.text();

  return new Response(body, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json;charset=UTF-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

// ---------------------------------------------------------------------------
// Torrentio — PM key comes from X-PM-Key header, embedded into the path
// ---------------------------------------------------------------------------

async function handleTorrentio(endpoint, request) {
  const pmKey = request.headers.get("X-PM-Key");
  if (!pmKey) {
    return jsonError(401, "X-PM-Key header is required for Torrentio requests.");
  }

  // endpoint arrives as e.g. "stream/movie/tt1234567.json"
  // We prefix the premiumize key into the Torrentio path exactly as the
  // original frontend did: torrentio.strem.fun/premiumize=<key>/stream/...
  const cleanEndpoint = endpoint.replace(/^\/+/, "");
  const upstreamUrl = `https://torrentio.strem.fun/premiumize=${pmKey}/${cleanEndpoint}`;

  const upstream = await fetch(upstreamUrl, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": BROWSER_UA,
      "Referer": "https://torrentio.strem.fun/",
      "Origin": "https://torrentio.strem.fun",
    },
    redirect: "follow",
  });

  const body = await upstream.text();

  return new Response(body, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json;charset=UTF-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json;charset=UTF-8" },
  });
}
