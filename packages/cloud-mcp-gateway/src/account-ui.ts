import type { ClerkPublicConfig } from "./clerk-auth.js";

export function renderAccountUi(config: ClerkPublicConfig | undefined): string {
  const configJson = JSON.stringify(config ?? null).replace(/</g, "\\u003c");
  const clerkScripts = config
    ? `
  <script defer crossorigin="anonymous" src="${escapeHtml(config.frontendApiUrl)}/npm/@clerk/ui@1/dist/ui.browser.js" type="text/javascript"></script>
  <script defer crossorigin="anonymous" data-clerk-publishable-key="${escapeHtml(config.publishableKey)}" src="${escapeHtml(config.frontendApiUrl)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js" type="text/javascript"></script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GSD MCP Account</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7f8;
      --surface: #ffffff;
      --surface-2: #eef3f1;
      --ink: #1b2624;
      --muted: #65716f;
      --line: rgba(21, 31, 29, 0.12);
      --shadow: 0 1px 2px rgba(11, 18, 17, 0.08), 0 14px 36px rgba(11, 18, 17, 0.08);
      --green: #12805c;
      --amber: #9a6700;
      --red: #b42318;
      --blue: #2764b0;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      font-variant-numeric: tabular-nums;
    }

    button, input { font: inherit; }

    button {
      min-height: 40px;
      border: 0;
      border-radius: 8px;
      padding: 0 14px;
      color: var(--surface);
      background: var(--ink);
      cursor: pointer;
      transition-property: background-color, color, transform, box-shadow;
      transition-duration: 140ms;
      transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
    }

    button:hover { background: #2c3a37; }
    button:active { transform: scale(0.96); }
    button:disabled { opacity: 0.48; cursor: not-allowed; transform: none; }

    button.secondary {
      color: var(--ink);
      background: var(--surface-2);
      box-shadow: inset 0 0 0 1px var(--line);
    }

    button.danger {
      background: #fff4f2;
      color: var(--red);
      box-shadow: inset 0 0 0 1px rgba(180, 35, 24, 0.24);
    }

    input {
      min-height: 40px;
      border: 0;
      border-radius: 8px;
      padding: 0 12px;
      color: var(--ink);
      background: var(--surface);
      box-shadow: inset 0 0 0 1px var(--line);
      outline: none;
      transition-property: box-shadow, background-color;
      transition-duration: 140ms;
      transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
    }

    input:focus {
      box-shadow: inset 0 0 0 1px rgba(18, 128, 92, 0.58), 0 0 0 3px rgba(18, 128, 92, 0.14);
    }

    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }

    .app {
      min-height: 100vh;
      padding: 24px;
    }

    .shell {
      width: min(1120px, 100%);
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }

    .topbar {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 20px;
      padding: 18px 0 4px;
    }

    .brand {
      display: grid;
      gap: 3px;
      min-width: 220px;
    }

    .eyebrow {
      color: var(--green);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    h1, h2 {
      margin: 0;
      letter-spacing: 0;
      text-wrap: balance;
    }

    h1 {
      font-size: clamp(28px, 4vw, 44px);
      line-height: 1.05;
    }

    h2 {
      font-size: 18px;
      line-height: 1.2;
    }

    .status {
      min-height: 40px;
      display: flex;
      align-items: center;
      padding: 0 14px;
      border-radius: 8px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.62);
      box-shadow: inset 0 0 0 1px var(--line);
    }

    .status.bad { color: var(--red); background: #fff4f2; }
    .status.good { color: var(--green); background: #effaf5; }

    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 12px;
    }

    .metric {
      min-height: 106px;
      padding: 16px;
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow);
      display: grid;
      align-content: space-between;
      gap: 14px;
    }

    .metric span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 750;
      text-transform: uppercase;
    }

    .metric strong {
      font-size: 30px;
      line-height: 1;
      letter-spacing: 0;
    }

    .panel {
      display: grid;
      gap: 14px;
      padding: 16px;
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }

    .panel[hidden] { display: none; }

    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .form-grid {
      display: grid;
      grid-template-columns: minmax(170px, 1fr) auto auto;
      align-items: end;
      gap: 10px;
      padding: 12px;
      border-radius: 8px;
      background: var(--surface-2);
    }

    .secret {
      display: none;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: end;
      padding: 12px;
      border-radius: 8px;
      background: #f2fbf8;
      box-shadow: inset 0 0 0 1px rgba(18, 128, 92, 0.22);
    }

    .secret.show { display: grid; }
    .secret code {
      display: block;
      overflow: auto;
      padding: 11px 12px;
      border-radius: 8px;
      color: var(--green);
      background: var(--surface);
      box-shadow: inset 0 0 0 1px rgba(18, 128, 92, 0.2);
      white-space: nowrap;
    }

    .table-wrap {
      overflow: auto;
      border-radius: 8px;
      box-shadow: inset 0 0 0 1px var(--line);
    }

    table {
      width: 100%;
      min-width: 700px;
      border-collapse: collapse;
      background: var(--surface);
    }

    th, td {
      padding: 12px;
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--line);
    }

    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      background: #fafbfb;
    }

    tr:last-child td { border-bottom: 0; }

    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .pill {
      min-height: 26px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 0 9px;
      color: var(--muted);
      background: var(--surface-2);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }

    .pill.good { color: var(--green); background: #effaf5; }
    .pill.warn { color: var(--amber); background: #fff8e6; }
    .pill.bad { color: var(--red); background: #fff4f2; }
    .pill.info { color: var(--blue); background: #eef6ff; }
    .muted { color: var(--muted); }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 170px;
    }

    .actions button {
      min-height: 36px;
      padding: 0 10px;
    }

    .auth-panel {
      min-height: 420px;
      display: grid;
      place-items: center;
    }

    @media (max-width: 760px) {
      .app { padding: 16px; }
      .topbar, .form-grid, .secret { grid-template-columns: 1fr; display: grid; align-items: stretch; }
    }
  </style>
  ${clerkScripts}
</head>
<body>
  <div class="app">
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="eyebrow">GSD Cloud MCP</div>
          <h1>My MCP Access</h1>
        </div>
        <div id="user-button"></div>
      </header>

      <div class="status" id="status">Loading</div>

      <section class="panel auth-panel" id="auth-panel">
        <div id="sign-in"></div>
      </section>

      <section class="metrics" id="metrics" hidden></section>

      <section class="secret" id="secret-panel">
        <label><span id="secret-title">Secret</span>
          <code id="secret-value"></code>
        </label>
        <button class="secondary" type="button" id="copy-secret">Copy</button>
      </section>

      <main class="panel" id="account-panel" hidden>
        <div class="panel-head">
          <h2>Tokens</h2>
          <button class="secondary" type="button" id="refresh">Refresh</button>
        </div>
        <form class="form-grid" id="create-token">
          <label>Label
            <input name="label" placeholder="Claude Desktop">
          </label>
          <button type="submit">Create Token</button>
          <button class="secondary" type="button" id="create-pairing">Pair Runtime</button>
        </form>
        <div class="table-wrap" id="tokens-table"></div>
      </main>
    </div>
  </div>

  <script>
    (function () {
      var clerkConfig = ${configJson};
      var state = { token: "", account: null, busy: false };

      document.getElementById("refresh").addEventListener("click", refresh);
      document.getElementById("copy-secret").addEventListener("click", function () {
        var value = document.getElementById("secret-value").textContent;
        navigator.clipboard.writeText(value).then(function () {
          setStatus("Copied", "good");
        }).catch(function () {
          setStatus("Copy failed", "bad");
        });
      });
      document.getElementById("create-token").addEventListener("submit", function (event) {
        event.preventDefault();
        var formNode = event.currentTarget;
        var form = new FormData(formNode);
        setBusy(true);
        api("/account/api/tokens", {
          method: "POST",
          body: { label: String(form.get("label") || "manual") }
        }).then(function (result) {
          formNode.reset();
          showSecret("New MCP token", result.userToken);
          return refresh();
        }).catch(showError).finally(function () {
          setBusy(false);
        });
      });
      document.getElementById("create-pairing").addEventListener("click", function () {
        setBusy(true);
        api("/account/api/pairing-codes", { method: "POST" }).then(function (result) {
          showSecret("Pairing code", result.code);
        }).catch(showError).finally(function () {
          setBusy(false);
        });
      });
      document.addEventListener("click", function (event) {
        var button = event.target.closest("button[data-action]");
        if (!button) return;
        if (button.getAttribute("data-action") === "revoke-token") {
          setBusy(true);
          api("/account/api/tokens/" + encodeURIComponent(button.getAttribute("data-token-id")) + "/revoke", {
            method: "POST"
          }).then(refresh).catch(showError).finally(function () {
            setBusy(false);
          });
        }
      });

      boot();

      async function boot() {
        if (!clerkConfig || !window.Clerk) {
          setStatus("Clerk is not configured", "bad");
          return;
        }
        await Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
        if (!Clerk.isSignedIn) {
          setStatus("Signed out", "");
          Clerk.mountSignIn(document.getElementById("sign-in"));
          return;
        }
        Clerk.mountUserButton(document.getElementById("user-button"));
        state.token = await Clerk.session.getToken();
        document.getElementById("auth-panel").hidden = true;
        document.getElementById("account-panel").hidden = false;
        document.getElementById("metrics").hidden = false;
        await refresh();
      }

      function refresh() {
        return api("/account/api/me").then(function (account) {
          state.account = account;
          render();
          setStatus("Connected", "good");
        }).catch(showError);
      }

      function api(path, options) {
        options = options || {};
        var headers = { "accept": "application/json", "authorization": "Bearer " + state.token };
        if (options.body !== undefined) headers["content-type"] = "application/json";
        return fetch(path, {
          method: options.method || "GET",
          headers: headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined
        }).then(function (response) {
          return response.text().then(function (text) {
            var payload = text ? JSON.parse(text) : {};
            if (!response.ok) throw new Error(payload.error || "Request failed");
            return payload;
          });
        });
      }

      function render() {
        var account = state.account || {};
        var quota = account.quota || {};
        var usage = account.usage || {};
        document.getElementById("metrics").innerHTML = [
          metric("Plan", account.user && account.user.plan ? account.user.plan : "free"),
          metric("Billable", usage.billableCalls || 0),
          metric("Throttled", usage.throttled || 0),
          metric("Quota", quotaLabel(quota))
        ].join("");
        renderTokens(account.tokens || []);
      }

      function renderTokens(tokens) {
        if (!tokens.length) {
          document.getElementById("tokens-table").innerHTML = '<div class="status">No tokens</div>';
          return;
        }
        var rows = tokens.map(function (token) {
          var status = token.revoked ? '<span class="pill bad">Revoked</span>' : '<span class="pill good">Active</span>';
          var actions = token.revoked ? "" : '<button class="danger" type="button" data-action="revoke-token" data-token-id="' + esc(token.tokenId) + '">Revoke</button>';
          return "<tr>" +
            "<td>" + esc(token.label || token.tokenId) + "</td>" +
            "<td>" + status + "</td>" +
            "<td>" + when(token.createdAt) + "</td>" +
            "<td>" + when(token.lastUsedAt) + "</td>" +
            '<td><div class="actions">' + actions + "</div></td>" +
          "</tr>";
        }).join("");
        document.getElementById("tokens-table").innerHTML = '<table><thead><tr><th>Label</th><th>Status</th><th>Created</th><th>Last used</th><th>Actions</th></tr></thead><tbody>' + rows + "</tbody></table>";
      }

      function metric(label, value) {
        return '<article class="metric"><span>' + esc(label) + '</span><strong>' + esc(value) + "</strong></article>";
      }

      function showSecret(title, value) {
        document.getElementById("secret-title").textContent = title;
        document.getElementById("secret-value").textContent = value;
        document.getElementById("secret-panel").classList.add("show");
        setStatus(title + " issued", "good");
      }

      function quotaLabel(quota) {
        var limits = quota.limits || {};
        var usage = quota.usage || {};
        if (!limits.callsPerDay && !limits.callsPerMonth && !limits.callsPerMinute) return "Unlimited";
        var parts = [];
        if (limits.callsPerDay) parts.push(number(usage.day || 0) + "/" + number(limits.callsPerDay) + " day");
        if (limits.callsPerMonth) parts.push(number(usage.month || 0) + "/" + number(limits.callsPerMonth) + " month");
        if (limits.callsPerMinute) parts.push(number(usage.minute || 0) + "/" + number(limits.callsPerMinute) + " min");
        return parts.join(" · ");
      }

      function setStatus(message, tone) {
        var node = document.getElementById("status");
        node.className = "status" + (tone ? " " + tone : "");
        node.textContent = message;
      }

      function showError(error) {
        setStatus(error && error.message ? error.message : String(error), "bad");
      }

      function setBusy(busy) {
        state.busy = busy;
        document.querySelectorAll("button").forEach(function (button) {
          button.disabled = busy;
        });
      }

      function esc(value) {
        return String(value == null ? "" : value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      function number(value) {
        return new Intl.NumberFormat().format(Number(value) || 0);
      }

      function when(value) {
        if (!value) return '<span class="muted">Never</span>';
        return esc(new Date(value).toLocaleString());
      }
    }());
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
