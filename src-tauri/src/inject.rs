//! JS injected into webviews (drag support, external link interception, and
//! the Exa dashboard scraper).

/// JS injected into every page (placeholder + dashboard) for drag support
/// and external link interception. Also injected via eval() after navigation
/// because js_init_script may not re-run on WKWebView cross-origin navigation.
pub(crate) const PAGE_INIT_JS: &str = r#"
(function() {
  if (window.__9r_init) return; window.__9r_init = true;
  // Window dragging: click top 40px to drag (excludes buttons/links)
  window.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    var s = 'button, input, textarea, a, select, option, [role="button"], [contenteditable="true"]';
    if (e.target.closest && e.target.closest(s)) return;
    if (e.clientY <= 40 && window.__TAURI_INTERNALS__) {
      window.__TAURI_INTERNALS__.invoke("plugin:window|start_dragging");
    }
  }, true);
  // External link interception
  function _openExternal(url) {
    try {
      var u = new URL(url, location.href);
      if ((u.protocol === 'http:' || u.protocol === 'https:') &&
          u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
        if (window.__TAURI_INTERNALS__) {
          window.__TAURI_INTERNALS__.invoke('plugin:shell|open', { path: u.href });
        }
        return true;
      }
    } catch(e) {}
    return false;
  }
  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a || !a.href) return;
    if (_openExternal(a.href)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  var _origOpen = window.open;
  window.open = function(url) {
    if (url && _openExternal(url)) return null;
    return _origOpen ? _origOpen.apply(this, arguments) : null;
  };
})();
"#;

/// Injected into the Exa dashboard window opened by the quota page's
/// "Sync Exa" button.
///
/// dashboard.exa.ai sits behind Vercel's bot challenge, so only a real browser
/// context can read its usage APIs. This script runs inside that context, calls
/// the same endpoints the dashboard itself calls, and hands the JSON back over
/// the Tauri event channel. Events (not custom commands) because remote pages
/// are blocked by the ACL — the same reason `hide-to-tray` uses an event.
pub(crate) const EXA_SYNC_JS_TEMPLATE: &str = r#"
(function () {
  if (location.hostname !== "dashboard.exa.ai") return;
  if (window.__9r_exa_sync) return;
  window.__9r_exa_sync = true;

  var CONNECTION_ID = "__CONNECTION_ID__";
  var EXPECTED_PREFIX = "__KEY_PREFIX__";
  var AUTO = "__AUTO__" === "1";
  var sent = false;
  var tries = 0;
  var banner = null;

  // The volume/keys endpoints take undocumented params (teamId + date range),
  // and the volume call may be a POST with a JSON body. Record the dashboard's
  // own request (url + method + body) and replay it first, instead of guessing.
  var seen = { volume: null, keys: null };
  (function () {
    function pickHeaders(headers) {
      if (!headers) return null;
      var picked = {};
      try {
        if (typeof Headers !== "undefined" && headers instanceof Headers) {
          headers.forEach(function (value, name) {
            var key = name.toLowerCase();
            if (key === "content-type" || key.indexOf("x-") === 0) picked[key] = value;
          });
        } else {
          Object.keys(headers).forEach(function (name) {
            var key = name.toLowerCase();
            if (key === "content-type" || key.indexOf("x-") === 0) picked[key] = headers[name];
          });
        }
      } catch (e) { return null; }
      return Object.keys(picked).length ? picked : null;
    }

    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = (typeof input === "string" ? input : (input && input.url)) || "";
        var method = (init && init.method) || (input && input.method) || "GET";
        var body = init && typeof init.body === "string" ? init.body : null;
        var req = { url: url, method: method, body: body, headers: pickHeaders(init && init.headers) };
        if (url.indexOf("usage-traffic") !== -1) seen.volume = req;
        else if (url.indexOf("api-keys") !== -1) seen.keys = req;
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  })();

  // Debug trail of every request this sync attempted (url/method/status), kept
  // in the snapshot so a failing endpoint can be diagnosed without a DevTools
  // session inside the app's webview.
  var attempts = [];

  function requestJSON(req) {
    if (!req || !req.url) return Promise.resolve(null);
    var headers = { accept: "application/json" };
    if (req.headers) {
      Object.keys(req.headers).forEach(function (k) { headers[k] = req.headers[k]; });
    }
    var opts = {
      method: req.method || "GET",
      credentials: "include",
      headers: headers
    };
    if (req.body != null) {
      if (!headers["content-type"]) headers["content-type"] = "application/json";
      opts.body = req.body;
    }
    return fetch(req.url, opts)
      .then(function (r) {
        attempts.push({ url: req.url, method: opts.method, status: r.status });
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        attempts.push({ url: req.url, method: opts.method, status: "error" });
        return null;
      });
  }

  function getJSON(url) {
    return requestJSON({ url: url, method: "GET" });
  }

  function isKeys(json) {
    return !!json && typeof json === "object" && Array.isArray(json.apiKeys);
  }

  function isVolume(json) {
    return !!json && typeof json === "object" &&
      (Array.isArray(json.rows) || Array.isArray(json.data) || typeof json.total === "number");
  }

  function firstValid(candidates, accept) {
    var i = 0;
    function next() {
      if (i >= candidates.length) return Promise.resolve(null);
      var req = candidates[i++];
      if (!req) return next();
      return requestJSON(req).then(function (json) {
        return accept(json) ? json : next();
      });
    }
    return next();
  }

  // Verified against the live dashboard (2026-10):
  //   GET  /api/get-api-keys              -> { apiKeys: [...] }   (/api/api-keys is 404)
  //   POST /api/usage-traffic/volume      -> { window, groupBy, rows }
  //        body: { startDate, endDate, groupBy: "endpoint" }      (GET is 405; teamId is rejected)
  // Replay the dashboard's own captured request first, then fall back to the
  // contract above.
  function getKeys() {
    return firstValid([
      seen.keys,
      { url: "/api/get-api-keys", method: "GET" }
    ], isKeys);
  }

  function getVolume() {
    var now = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    // Local calendar month: Exa bills monthly, so last month's requests must not
    // be mixed into the current cycle's count.
    var day = function (d) {
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    };
    var startDate = day(new Date(now.getFullYear(), now.getMonth(), 1));
    var endDate = day(now);

    return firstValid([
      seen.volume,
      {
        url: "/api/usage-traffic/volume",
        method: "POST",
        body: JSON.stringify({ startDate: startDate, endDate: endDate, groupBy: "endpoint" })
      }
    ], isVolume);
  }

  function showBanner(text) {
    if (banner) { banner.textContent = text; return; }
    banner = document.createElement("div");
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 16px;background:#7c2d12;color:#fff;font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)";
    banner.textContent = text;
    document.documentElement.appendChild(banner);
  }

  function clearBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  // Auto-sync windows are hidden; if nothing comes back after ~36s, tell Rust
  // to close the window instead of leaving an invisible webview behind.
  function abort() {
    sent = true;
    try {
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "exa-sync-abort",
        payload: { connectionId: CONNECTION_ID }
      });
    } catch (e) {}
  }

  function tick() {
    if (sent) return;
    tries += 1;
    getJSON("/api/get-credits").then(function (credits) {
      // Not logged in yet — the login page also answers, just without credits.
      if (!credits || typeof credits.orbCreditsInCents !== "number") {
        if (AUTO && tries >= 12) abort();
        return;
      }

      getJSON("/api/team-context").then(function (teamContext) {
        attempts = [];
        Promise.all([getKeys(), getVolume()]).then(function (results) {
          var keys = results[0];
          var volume = results[1];

          // Exa credits are team-level, so the logged-in account must own the
          // key behind this connection — otherwise the balance is someone else's.
          if (EXPECTED_PREFIX && isKeys(keys)) {
            var owns = keys.apiKeys.some(function (k) {
              return k && k.bearerPrefix === EXPECTED_PREFIX;
            });
            if (!owns) {
              showBanner("当前登录的 Exa 账户不拥有这个连接使用的 API Key。请在此页面切换到对应账户，检测到匹配后会自动完成同步。");
              if (AUTO && tries >= 12) abort();
              return;
            }
          }
          clearBanner();
          sent = true;

          return window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
            event: "exa-sync-result",
            payload: {
              connectionId: CONNECTION_ID,
              credits: credits,
              volume: volume || null,
              teamContext: teamContext || null,
              apiKeys: keys || null,
              debug: attempts.slice(0, 40),
              syncedAt: new Date().toISOString()
            }
          });
        }).catch(function () { sent = false; });
      });
    });
  }

  // Run immediately: hidden auto-sync windows may have their timers throttled.
  tick();
  setInterval(tick, 3000);
})();
"#;
