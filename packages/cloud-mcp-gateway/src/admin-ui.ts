export function renderAdminUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GSD Cloud MCP Admin</title>
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
      --teal: #0f766e;
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

    button, input, select {
      font: inherit;
    }

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

    button.secondary:hover { background: #e2ebe8; }

    button.danger {
      background: #fff4f2;
      color: var(--red);
      box-shadow: inset 0 0 0 1px rgba(180, 35, 24, 0.24);
    }

    button.danger:hover { background: #ffe6e1; }

    input, select {
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

    input:focus, select:focus {
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
      width: min(1280px, 100%);
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
      color: var(--teal);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    h1, h2 {
      margin: 0;
      text-wrap: balance;
      letter-spacing: 0;
    }

    h1 {
      font-size: clamp(28px, 4vw, 44px);
      line-height: 1.05;
    }

    h2 {
      font-size: 18px;
      line-height: 1.2;
    }

    .auth {
      display: grid;
      grid-template-columns: minmax(220px, 360px) auto auto;
      align-items: end;
      gap: 10px;
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
      font-size: 32px;
      line-height: 1;
      letter-spacing: 0;
    }

    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 4px;
      width: fit-content;
      border-radius: 8px;
      background: var(--surface-2);
      box-shadow: inset 0 0 0 1px var(--line);
    }

    .tab {
      color: var(--muted);
      background: transparent;
      box-shadow: none;
    }

    .tab:hover { color: var(--ink); background: rgba(255, 255, 255, 0.72); }
    .tab.active { color: var(--ink); background: var(--surface); box-shadow: 0 1px 2px rgba(11, 18, 17, 0.08); }

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
      grid-template-columns: minmax(160px, 1fr) minmax(190px, 1fr) 130px 150px minmax(130px, auto);
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
      min-width: 760px;
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

    .main-cell {
      display: grid;
      gap: 3px;
      min-width: 200px;
    }

    .main-cell strong { font-size: 14px; }
    .main-cell span, .muted { color: var(--muted); }

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

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 220px;
    }

    .actions button {
      min-height: 36px;
      padding: 0 10px;
    }

    .usage-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
    }

    .empty {
      min-height: 120px;
      display: grid;
      place-items: center;
      color: var(--muted);
      background: var(--surface-2);
      border-radius: 8px;
      text-align: center;
      text-wrap: pretty;
    }

    @media (max-width: 880px) {
      .app { padding: 16px; }
      .topbar { display: grid; align-items: stretch; }
      .auth, .form-grid, .secret, .usage-grid { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 560px) {
      .metrics { grid-template-columns: 1fr; }
      .panel { padding: 12px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="eyebrow">GSD Cloud MCP</div>
          <h1>Users and Usage</h1>
        </div>
        <form class="auth" id="auth-form">
          <label>Admin token
            <input id="admin-token" type="password" autocomplete="off">
          </label>
          <button type="submit">Connect</button>
          <button class="secondary" id="clear-token" type="button">Clear</button>
        </form>
      </header>

      <div class="status" id="status">Disconnected</div>

      <section class="metrics" id="metrics"></section>

      <nav class="tabs" aria-label="Admin views">
        <button class="tab active" type="button" data-tab="users">Users</button>
        <button class="tab" type="button" data-tab="usage">Usage</button>
        <button class="tab" type="button" data-tab="runtimes">Runtimes</button>
      </nav>

      <section class="secret" id="secret-panel">
        <label><span id="secret-title">Secret</span>
          <code id="secret-value"></code>
        </label>
        <button class="secondary" type="button" id="copy-secret">Copy</button>
      </section>

      <main>
        <section class="panel" id="panel-users">
          <div class="panel-head">
            <h2>User Registry</h2>
            <button class="secondary" type="button" id="refresh">Refresh</button>
          </div>
          <form class="form-grid" id="create-user">
            <label>Name
              <input name="name" placeholder="Ada Lovelace" autocomplete="name">
            </label>
            <label>Email
              <input name="email" placeholder="ada@example.com" autocomplete="email">
            </label>
            <label>Role
              <select name="role">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <label>Plan
              <select name="plan">
                <option value="free">Free</option>
                <option value="paid">Paid</option>
                <option value="unlimited">Unlimited</option>
              </select>
            </label>
            <button type="submit">Create User</button>
          </form>
          <div class="table-wrap" id="users-table"></div>
        </section>

        <section class="panel" id="panel-usage" hidden>
          <div class="panel-head">
            <h2>Usage</h2>
          </div>
          <div class="usage-grid">
            <div class="table-wrap" id="usage-users"></div>
            <div class="table-wrap" id="usage-tools"></div>
          </div>
          <div class="table-wrap" id="usage-events"></div>
        </section>

        <section class="panel" id="panel-runtimes" hidden>
          <div class="panel-head">
            <h2>Connected Runtimes</h2>
          </div>
          <div class="table-wrap" id="runtimes-table"></div>
        </section>
      </main>
    </div>
  </div>

  <script>
    (function () {
      var state = {
        token: localStorage.getItem("gsdCloudAdminToken") || "",
        tab: "users",
        users: [],
        runtimes: [],
        usage: null,
        overview: null,
        busy: false
      };

      var tokenInput = document.getElementById("admin-token");
      tokenInput.value = state.token;

      document.getElementById("auth-form").addEventListener("submit", function (event) {
        event.preventDefault();
        state.token = tokenInput.value.trim();
        if (state.token) localStorage.setItem("gsdCloudAdminToken", state.token);
        refresh();
      });

      document.getElementById("clear-token").addEventListener("click", function () {
        state.token = "";
        tokenInput.value = "";
        localStorage.removeItem("gsdCloudAdminToken");
        state.users = [];
        state.runtimes = [];
        state.usage = null;
        state.overview = null;
        hideSecret();
        render();
        setStatus("Disconnected", "");
      });

      document.getElementById("refresh").addEventListener("click", refresh);
      document.getElementById("copy-secret").addEventListener("click", function () {
        var value = document.getElementById("secret-value").textContent;
        navigator.clipboard.writeText(value).then(function () {
          setStatus("Copied", "good");
        }).catch(function () {
          setStatus("Copy failed", "bad");
        });
      });

      document.querySelectorAll(".tab").forEach(function (button) {
        button.addEventListener("click", function () {
          state.tab = button.getAttribute("data-tab");
          renderTabs();
        });
      });

      document.getElementById("create-user").addEventListener("submit", function (event) {
        event.preventDefault();
        var formNode = event.currentTarget;
        var form = new FormData(formNode);
        api("/admin/api/users", {
          method: "POST",
          body: {
            name: String(form.get("name") || ""),
            email: String(form.get("email") || ""),
            role: String(form.get("role") || "member"),
            plan: String(form.get("plan") || "free"),
            issueToken: true
          }
        }).then(function (result) {
          formNode.reset();
          if (result.userToken) showSecret("New user token", result.userToken);
          return refresh();
        }).catch(showError);
      });

      document.addEventListener("click", function (event) {
        var button = event.target.closest("button[data-action]");
        if (!button) return;
        var action = button.getAttribute("data-action");
        var userId = button.getAttribute("data-user-id");
        var tokenId = button.getAttribute("data-token-id");
        if (action === "issue-token") {
          api("/admin/api/users/" + encodeURIComponent(userId) + "/tokens", {
            method: "POST",
            body: { label: "manual" }
          }).then(function (result) {
            showSecret("New user token", result.userToken);
            return refresh();
          }).catch(showError);
        }
        if (action === "pairing-code") {
          api("/admin/api/users/" + encodeURIComponent(userId) + "/pairing-codes", {
            method: "POST"
          }).then(function (result) {
            showSecret("Pairing code", result.code);
          }).catch(showError);
        }
        if (action === "toggle-user") {
          api("/admin/api/users/" + encodeURIComponent(userId) + "/disabled", {
            method: "POST",
            body: { disabled: button.getAttribute("data-disabled") !== "true" }
          }).then(refresh).catch(showError);
        }
        if (action === "revoke-token") {
          api("/admin/api/tokens/" + encodeURIComponent(tokenId) + "/revoke", {
            method: "POST"
          }).then(refresh).catch(showError);
        }
      });

      function refresh() {
        if (!state.token) {
          setStatus("Admin token required", "bad");
          render();
          return Promise.resolve();
        }
        setBusy(true);
        return Promise.all([
          api("/admin/api/overview"),
          api("/admin/api/users"),
          api("/admin/api/runtimes"),
          api("/admin/api/usage")
        ]).then(function (parts) {
          state.overview = parts[0];
          state.users = parts[1].users || [];
          state.runtimes = parts[2].runtimes || [];
          state.usage = parts[3];
          render();
          setStatus("Connected", "good");
        }).catch(function (error) {
          showError(error);
          render();
        }).finally(function () {
          setBusy(false);
        });
      }

      function api(path, options) {
        options = options || {};
        var headers = { "accept": "application/json" };
        if (state.token) headers.authorization = "Bearer " + state.token;
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
        renderMetrics();
        renderUsers();
        renderUsage();
        renderRuntimes();
        renderTabs();
      }

      function renderMetrics() {
        var overview = state.overview || {};
        document.getElementById("metrics").innerHTML = [
          metric("Users", overview.totalUsers || 0),
          metric("Active users", overview.activeUsers || 0),
          metric("Online runtimes", overview.onlineRuntimes || 0),
          metric("Billable calls", overview.billableCalls || 0),
          metric("Throttled", overview.throttledCalls || 0)
        ].join("");
      }

      function metric(label, value) {
        return '<article class="metric"><span>' + esc(label) + '</span><strong>' + number(value) + "</strong></article>";
      }

      function renderUsers() {
        if (!state.users.length) {
          document.getElementById("users-table").innerHTML = '<div class="empty">No users yet</div>';
          return;
        }
        var rows = state.users.map(function (user) {
          var tokens = user.tokens || [];
          var usage = user.usage || {};
          var quota = user.quota || {};
          var status = user.disabled ? '<span class="pill bad">Disabled</span>' : '<span class="pill good">Active</span>';
          var quotaTone = quota.allowed === false ? "bad" : quota.remaining && (quota.remaining.day === 0 || quota.remaining.month === 0) ? "warn" : "info";
          var tokenPills = tokens.length ? tokens.map(function (token) {
            var cls = token.revoked ? "pill bad" : "pill info";
            var label = token.label || token.tokenId.slice(0, 10);
            var revoke = token.revoked ? "" : ' <button class="danger" type="button" data-action="revoke-token" data-token-id="' + esc(token.tokenId) + '">Revoke</button>';
            return '<span class="' + cls + '">' + esc(label) + "</span>" + revoke;
          }).join(" ") : '<span class="muted">No tokens</span>';
          return "<tr>" +
            '<td><div class="main-cell"><strong>' + esc(user.name || user.email || user.userId) + "</strong><span>" + esc(user.email || user.userId) + "</span></div></td>" +
            '<td><div class="pill-row">' + status + '<span class="pill">' + esc(user.role) + '</span><span class="pill ' + (user.plan === "free" ? "warn" : "info") + '">' + esc(user.plan || "free") + "</span></div></td>" +
            '<td>' + number(usage.billableCalls || 0) + '</td>' +
            '<td><span class="pill ' + quotaTone + '">' + esc(quotaLabel(quota)) + "</span></td>" +
            '<td>' + when(user.lastSeenAt) + '</td>' +
            '<td><div class="pill-row">' + tokenPills + "</div></td>" +
            '<td><div class="actions">' +
              '<button class="secondary" type="button" data-action="issue-token" data-user-id="' + esc(user.userId) + '">Token</button>' +
              '<button class="secondary" type="button" data-action="pairing-code" data-user-id="' + esc(user.userId) + '">Pair</button>' +
              '<button class="' + (user.disabled ? "secondary" : "danger") + '" type="button" data-action="toggle-user" data-user-id="' + esc(user.userId) + '" data-disabled="' + String(Boolean(user.disabled)) + '">' + (user.disabled ? "Enable" : "Disable") + "</button>" +
            "</div></td>" +
          "</tr>";
        }).join("");
        document.getElementById("users-table").innerHTML = '<table><thead><tr><th>User</th><th>Status</th><th>Billable</th><th>Quota</th><th>Last seen</th><th>Tokens</th><th>Actions</th></tr></thead><tbody>' + rows + "</tbody></table>";
      }

      function renderUsage() {
        var usage = state.usage || { byUser: [], byTool: [], recentEvents: [] };
        document.getElementById("usage-users").innerHTML = usageTable("Users", "userId", usage.byUser || []);
        document.getElementById("usage-tools").innerHTML = usageTable("Tools", "toolName", usage.byTool || []);
        var events = usage.recentEvents || [];
        if (!events.length) {
          document.getElementById("usage-events").innerHTML = '<div class="empty">No tool calls recorded</div>';
          return;
        }
        var rows = events.map(function (event) {
          return "<tr>" +
            "<td>" + esc(event.toolName) + "</td>" +
            "<td>" + esc(event.userId) + "</td>" +
            "<td>" + eventStatus(event) + "</td>" +
            "<td>" + number(event.durationMs) + " ms</td>" +
            "<td>" + when(event.startedAt) + "</td>" +
          "</tr>";
        }).join("");
        document.getElementById("usage-events").innerHTML = '<table><thead><tr><th>Tool</th><th>User</th><th>Status</th><th>Duration</th><th>Time</th></tr></thead><tbody>' + rows + "</tbody></table>";
      }

      function usageTable(title, key, rows) {
        if (!rows.length) return '<div class="empty">' + esc(title) + ': no usage</div>';
        var body = rows.map(function (row) {
          return "<tr><td>" + esc(row[key] || "") + "</td><td>" + number(row.billableCalls || 0) + "</td><td>" + number(row.throttled || 0) + "</td><td>" + number(row.failures || 0) + "</td><td>" + number(row.averageDurationMs || 0) + " ms</td></tr>";
        }).join("");
        return '<table><thead><tr><th>' + esc(title) + '</th><th>Billable</th><th>Throttled</th><th>Errors</th><th>Avg</th></tr></thead><tbody>' + body + "</tbody></table>";
      }

      function renderRuntimes() {
        if (!state.runtimes.length) {
          document.getElementById("runtimes-table").innerHTML = '<div class="empty">No runtimes connected</div>';
          return;
        }
        var rows = state.runtimes.map(function (runtime) {
          return "<tr>" +
            '<td><div class="main-cell"><strong>' + esc(runtime.runtimeName || runtime.runtimeId) + "</strong><span>" + esc(runtime.runtimeId) + "</span></div></td>" +
            "<td>" + esc(runtime.userId) + "</td>" +
            "<td>" + number(runtime.projectCount || 0) + "</td>" +
            "<td>" + number(runtime.toolCount || 0) + "</td>" +
            "<td>" + when(runtime.lastSeenAt) + "</td>" +
          "</tr>";
        }).join("");
        document.getElementById("runtimes-table").innerHTML = '<table><thead><tr><th>Runtime</th><th>User</th><th>Projects</th><th>Tools</th><th>Last seen</th></tr></thead><tbody>' + rows + "</tbody></table>";
      }

      function renderTabs() {
        document.querySelectorAll(".tab").forEach(function (button) {
          button.classList.toggle("active", button.getAttribute("data-tab") === state.tab);
        });
        ["users", "usage", "runtimes"].forEach(function (tab) {
          document.getElementById("panel-" + tab).hidden = state.tab !== tab;
        });
      }

      function showSecret(title, value) {
        document.getElementById("secret-title").textContent = title;
        document.getElementById("secret-value").textContent = value;
        document.getElementById("secret-panel").classList.add("show");
        setStatus(title + " issued", "good");
      }

      function hideSecret() {
        document.getElementById("secret-panel").classList.remove("show");
      }

      function setStatus(message, tone) {
        var node = document.getElementById("status");
        node.className = "status" + (tone ? " " + tone : "");
        node.textContent = message;
      }

      function showError(error) {
        setStatus(error && error.message ? error.message : String(error), "bad");
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

      function eventStatus(event) {
        if (event.throttled) return '<span class="pill warn">Throttled</span>';
        if (event.ok) return '<span class="pill good">OK</span>';
        return '<span class="pill bad">Error</span>';
      }

      function setBusy(busy) {
        state.busy = busy;
        document.querySelectorAll("button").forEach(function (button) {
          if (button.id !== "clear-token") button.disabled = busy;
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

      render();
      if (state.token) refresh();
    }());
  </script>
</body>
</html>`;
}
