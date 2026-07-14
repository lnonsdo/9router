/**
 * Volcengine V4 request signer (pure JS, Node crypto only)
 *
 * Signs a request against the Volcengine / Ark OpenAPI (管控面) using the
 * standard HMAC-SHA256 V4 algorithm. AK/SK are long-lived credentials stored
 * in providerSpecificData, so unlike the ark-cli STS flow there is NO 2-day
 * refresh_token expiry — the signature is computed fresh for every request.
 *
 * Reference: https://www.volcengine.com/docs/6369/67269
 *
 * Usage:
 *   const { authorization, xDate, xContentSha256 } = await signV4({
 *     method: "POST",
 *     host: "ark.cn-beijing.volcengineapi.com",
 *     path: "/",
 *     query: { Action: "GetPersonalPlan", Version: "2024-01-01" },
 *     body: "",                       // raw request body string
 *     ak, sk,
 *     service: "ark",
 *     region: "cn-beijing",
 *   });
 *   // then set headers: Authorization, X-Date, X-Content-Sha256, Host
 */

import crypto from "crypto";

const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/**
 * Hash helper (SHA256 hex)
 */
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * HMAC-SHA256, returns raw Buffer
 */
function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * HMAC-SHA256 hex
 */
function hmacHex(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/**
 * HMAC-SHA256 returning a hex STRING (used as the key for the next HMAC step,
 * per Volcengine spec: each derived key is the hex form of the previous one).
 */
function hmacHexKey(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/**
 * Canonicalize query string (RFC 3986, sorted, no encoding of = and &)
 */
function canonicalQueryString(query = {}) {
  const keys = Object.keys(query).sort();
  if (keys.length === 0) return "";
  return keys
    .map((k) => {
      const v = query[k];
      // Skip null/undefined; keep empty string as key=
      if (v === null || v === undefined) return null;
      return `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
    })
    .filter(Boolean)
    .join("&");
}

/**
 * Canonicalize headers. Per Volcengine V4 spec, only `host` and `x-date`
 * are signed (SignedHeaders=host;x-date). The `X-Content-Sha256` header is
 * sent on the wire for body-integrity checks but is NOT part of the signature.
 * Reference: https://www.volcengine.com/docs/6369/67269
 */
function canonicalHeaders(host, xDate) {
  const entries = [
    ["host", host],
    ["x-date", xDate],
  ];
  // SignedHeaders (lowercased, sorted, semicolon-joined)
  const signedHeaders = entries
    .map(([k]) => k.toLowerCase())
    .sort()
    .join(";");
  // Canonical header lines: "key:value\n" (trimmed value, lowercased key)
  const headerLines = entries
    .map(([k, v]) => `${k.toLowerCase()}:${String(v).trim()}\n`)
    .join("");
  return { signedHeaders, headerLines };
}

/**
 * Build the V4 Authorization header value + companion headers.
 *
 * @param {object} opts
 * @param {string} opts.method   HTTP method (GET/POST/...)
 * @param {string} opts.host     Host header value (e.g. ark.cn-beijing.volcengineapi.com)
 * @param {string} opts.path      Request path, including leading "/" (query stays in opts.query)
 * @param {object} [opts.query]   Query params object (will be canonicalized + signed)
 * @param {string} [opts.body]    Raw request body string (POST/PUT). Use "" for GET.
 * @param {string} opts.ak        Access Key ID
 * @param {string} opts.sk        Secret Access Key
 * @param {string} [opts.service] Volcengine service name, default "ark"
 * @param {string} [opts.region]  Region, default "cn-beijing"
 * @returns {{ authorization: string, xDate: string, xContentSha256: string, signedQuery: string }}
 */
export function signV4(opts) {
  const {
    method,
    host,
    path = "/",
    query = {},
    body = "",
    ak,
    sk,
    service = "ark",
    region = "cn-beijing",
    xDateOverride = null,
  } = opts;

  if (!ak || !sk) {
    throw new Error("signV4 requires ak and sk");
  }

  const httpMethod = String(method).toUpperCase();

  // 1. Payload hash
  const xContentSha256 = sha256Hex(body || "");

  // 2. X-Date (ISO8601 UTC, e.g. 20240710T042925Z)
  //    from "2024-07-10T04:29:25.123Z" -> "20240710T042925Z"
  const xDate =
    xDateOverride ||
    (() => {
      const now = new Date();
      return now
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
    })();
  const dateStamp = xDate.slice(0, 8); // YYYYMMDD

  // 3. Canonical request (only host + x-date are signed)
  const { signedHeaders, headerLines } = canonicalHeaders(host, xDate);
  const cqs = canonicalQueryString(query);
  const canonicalRequest = [
    httpMethod,
    path,
    cqs,
    headerLines,
    signedHeaders,
    xContentSha256,
  ].join("\n");

  // 4. String to sign
  const credentialScope = `${dateStamp}/${region}/${service}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // 5. Signing key — standard AWS/Volcengine V4 chain.
  // Each step uses the RAW BINARY digest (Buffer) of the previous HMAC as the
  // next key (NOT the hex string). The seed key is the raw Secret Access Key.
  const kDate = hmac(sk, dateStamp);       // Buffer
  const kRegion = hmac(kDate, region);     // Buffer
  const kService = hmac(kRegion, service); // Buffer
  const kSigning = hmac(kService, "request"); // Buffer
  const signature = hmacHex(kSigning, stringToSign); // hex

  // 6. Authorization header
  const authorization =
    `HMAC-SHA256 ` +
    `Credential=${ak}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  return {
    authorization,
    xDate,
    xContentSha256,
    signedQuery: cqs,
  };
}

/**
 * Convenience: perform a signed request to the Ark OpenAPI and return parsed JSON.
 * Uses global fetch (already patched by proxyFetch in open-sse/index.js so it
 * respects connection proxy config when called within the SSE process).
 *
 * @param {object} opts  same as signV4 + { action, version, payload, baseUrl }
 * @returns {Promise<object>} parsed JSON response
 */
export async function callArkOpenApi(opts) {
  const {
    ak,
    sk,
    action,
    version = "2024-01-01",
    payload = {},
    baseUrl = "https://ark.cn-beijing.volcengineapi.com",
    service = "ark",
    region = "cn-beijing",
    extraQuery = {},
  } = opts;

  if (!action) throw new Error("callArkOpenApi requires action");

  const url = new URL(baseUrl);
  const host = url.host;
  const path = url.pathname || "/";

  const query = {
    Action: action,
    Version: version,
    ...extraQuery,
  };

  const bodyStr = JSON.stringify(payload);
  const { authorization, xDate, xContentSha256, signedQuery } = signV4({
    method: "POST",
    host,
    path,
    query,
    body: bodyStr,
    ak,
    sk,
    service,
    region,
  });

  const fullUrl = `${baseUrl}?${signedQuery}`;
  const res = await fetch(fullUrl, {
    method: "POST",
    headers: {
      Host: host,
      Authorization: authorization,
      "X-Date": xDate,
      "X-Content-Sha256": xContentSha256,
      "Content-Type": "application/json",
    },
    body: bodyStr,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Ark OpenAPI ${action} returned non-JSON: ${text.slice(0, 300)}`);
  }

  // Volcengine wraps errors in ResponseMetadata.Error
  const err = data?.ResponseMetadata?.Error;
  if (err) {
    throw new Error(`Ark OpenAPI ${action} failed: ${err.Code} - ${err.Message}`);
  }
  if (!res.ok) {
    throw new Error(`Ark OpenAPI ${action} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  return data;
}
