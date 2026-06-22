// api/massive.js
// Vercel serverless proxy for the Massive.com REST API.
// The browser calls /api/massive?path=<encoded massive path> and this function
// forwards it to https://api.massive.com with your secret key attached.
//
// Why a proxy: the API key must stay server-side, and Massive does not send
// browser-friendly CORS headers. This function holds the key (as an env var)
// and re-serves the JSON with CORS scoped to your own origin.
//
// Env vars (set in Vercel → Project → Settings → Environment Variables):
//   MASSIVE_API_KEY   your Massive API key (required)
//   ALLOWED_ORIGIN    your dashboard origin, e.g. https://my-desk.vercel.app
//                     (optional; defaults to "*". Set it to lock the proxy down.)

const BASE = "https://api.massive.com";

// Only allow the endpoints the dashboard actually uses. This stops the proxy
// from being turned into an open relay for your key.
const ALLOWED_PREFIXES = [
  "/v3/snapshot",        // unified snapshot (quotes)
  "/v2/aggs/ticker/",    // custom OHLC bars
  "/v2/reference/news",  // ticker news + sentiment
  "/v1/marketstatus/",   // market status
];

function isAllowed(path) {
  return ALLOWED_PREFIXES.some((p) => path.startsWith(p));
}

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Cache snapshots/bars briefly at the edge to spare your rate limit.
  res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=15");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  const key = process.env.MASSIVE_API_KEY;
  if (!key) return res.status(500).json({ error: "MASSIVE_API_KEY not configured" });

  // The dashboard passes the endpoint in ?path= and all other Massive query
  // params as ordinary query params alongside it. We strip `path`, forward the
  // rest. e.g. ?path=/v3/snapshot&ticker.any_of=AAPL,MSFT&type=stocks
  const raw = req.query.path;
  if (!raw || typeof raw !== "string") {
    return res.status(400).json({ error: "missing ?path=" });
  }

  const pathOnly = (raw.startsWith("/") ? raw : `/${raw}`).split("?")[0];
  if (!isAllowed(pathOnly)) {
    return res.status(403).json({ error: `path not allowed: ${pathOnly}` });
  }

  // Rebuild the upstream query from everything except `path`.
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === "path") continue;
    if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
    else params.append(k, v);
  }
  const qs = params.toString();
  const upstreamUrl = `${BASE}${pathOnly}${qs ? `?${qs}` : ""}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "gzip" },
    });
    const body = await upstream.text(); // pass through as-is
    res
      .status(upstream.status)
      .setHeader("Content-Type", "application/json")
      .send(body);
  } catch (e) {
    res.status(502).json({ error: "upstream fetch failed", detail: String(e) });
  }
}
