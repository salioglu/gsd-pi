# @opengsd/cloud-mcp-gateway

Cloud-hosted MCP gateway for brokering remote MCP clients to a paired Local GSD Runtime.

The gateway is a live routing layer. It does not host workspaces, clone source code, store `.gsd` artifacts, or run GSD workflows itself.

## Hosting GSD + Browser MCPs

Run the gateway on a public HTTPS host and pair a Local GSD Runtime from the machine that owns the workspaces and browser profile. Remote MCP clients connect to the gateway's Streamable HTTP endpoint at `/mcp`; tool calls are forwarded to the paired local runtime.

The local runtime always advertises the GSD MCP tools. It also advertises `gsd-browser mcp` tools when `gsd-browser` is installed on `PATH`:

```bash
npm install -g @opengsd/gsd-browser
gsd-mcp-runtime connect --verbose
```

To configure the browser MCP command explicitly:

```bash
export GSD_CLOUD_BROWSER_MCP_COMMAND=gsd-browser
export GSD_CLOUD_BROWSER_MCP_ARGS=mcp
gsd-mcp-runtime connect --verbose
```

To disable browser MCP advertisement:

```bash
export GSD_CLOUD_BROWSER_MCP=0
gsd-mcp-runtime connect
```

To advertise additional stdio MCP servers from the same runtime:

```bash
export GSD_CLOUD_MCP_SERVERS='[
  { "id": "gsd-browser", "command": "gsd-browser", "args": ["mcp"] }
]'
gsd-mcp-runtime connect --verbose
```

Keep `GSD_CLOUD_USER_TOKEN` private and require it as a bearer token for `/mcp`. Do not expose the local runtime websocket directly; it should only dial out to the gateway with its paired device token.

## Local Smoke Test

Build and start the gateway with persistent auth storage:

```bash
export GSD_CLOUD_USER_TOKEN="$(openssl rand -hex 32)"
export GSD_CLOUD_ADMIN_TOKEN="$(openssl rand -hex 32)"
npm run build -w @opengsd/cloud-mcp-gateway
node packages/cloud-mcp-gateway/dist/cli.js \
  --port 8787 \
  --auth-store ./.tmp/gsd-cloud-auth.json \
  --usage-store ./.tmp/gsd-cloud-usage.json
```

Open `http://localhost:8787/admin` and connect with `GSD_CLOUD_ADMIN_TOKEN`. If `GSD_CLOUD_ADMIN_TOKEN` is not set, the seeded admin user token from `GSD_CLOUD_USER_TOKEN` can access the admin API.

Create a pairing code:

```bash
curl -s -X POST http://localhost:8787/pairing-codes \
  -H "Authorization: Bearer $GSD_CLOUD_USER_TOKEN" \
  -H 'Content-Type: application/json'
```

Pair and connect the local daemon with the returned code:

```bash
npm run build -w @opengsd/daemon
node packages/daemon/dist/cli.js cloud pair \
  --gateway http://localhost:8787 \
  --code <CODE> \
  --runtime-name local-dev

node packages/daemon/dist/cli.js cloud connect --verbose
```

List projects through MCP:

```bash
node --input-type=module <<'NODE'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "gateway-smoke", version: "0.0.1" });
const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:8787/mcp"),
  { requestInit: { headers: { Authorization: `Bearer ${process.env.GSD_CLOUD_USER_TOKEN}` } } },
);

await client.connect(transport);
const result = await client.callTool({ name: "gsd_cloud_projects", arguments: {} });
console.log(result.content[0].text);
await client.close();
NODE
```

## Auth Storage

By default, the gateway uses in-memory auth state for local development and tests.

For persistent auth state, set one of:

```bash
node packages/cloud-mcp-gateway/dist/cli.js --auth-store /secure/path/gsd-cloud-auth.json
GSD_CLOUD_AUTH_STORE_PATH=/secure/path/gsd-cloud-auth.json node packages/cloud-mcp-gateway/dist/cli.js
```

The auth store persists user tokens, device tokens, and pairing codes as salted scrypt-derived hashes. Raw bearer tokens and device tokens are not written to disk.

`GSD_CLOUD_USER_TOKEN` seeds the initial user bearer token and is required at startup.

## User Management

The gateway serves a built-in management frontend at `/admin`. The UI lets an operator:

- create users with `member` or `admin` roles
- assign `free`, `paid`, or `unlimited` usage plans
- issue user bearer tokens and pairing codes
- revoke user tokens
- disable or re-enable users
- view connected runtimes
- inspect aggregate MCP usage and recent tool calls

Admin API routes live under `/admin/api/*` and require a bearer token. Set `GSD_CLOUD_ADMIN_TOKEN` for a dedicated operator secret:

```bash
export GSD_CLOUD_ADMIN_TOKEN="$(openssl rand -hex 32)"
node packages/cloud-mcp-gateway/dist/cli.js --auth-store /secure/path/gsd-cloud-auth.json
```

When `GSD_CLOUD_ADMIN_TOKEN` is not set, only users with the `admin` role can call the admin API. The startup seed user is created as an admin.

Public self-registration is disabled by default. To allow anonymous `POST /register` calls that create `member` users and return a one-time bearer token:

```bash
node packages/cloud-mcp-gateway/dist/cli.js --allow-registration
# or
GSD_CLOUD_ALLOW_REGISTRATION=1 node packages/cloud-mcp-gateway/dist/cli.js
```

## Clerk User Accounts

For public sign-up/sign-in, enable Clerk and send users to `/account`. Clerk authenticates the human user; the gateway still creates, hashes, revokes, throttles, and tallies MCP bearer tokens.

```bash
export CLERK_SECRET_KEY=sk_live_...
export CLERK_PUBLISHABLE_KEY=pk_live_...
# Optional: networkless JWT verification.
export CLERK_JWT_KEY='-----BEGIN PUBLIC KEY-----...'

node packages/cloud-mcp-gateway/dist/cli.js \
  --auth-store /secure/path/gsd-cloud-auth.json \
  --usage-store /secure/path/gsd-cloud-usage.json
```

The `/account` page loads ClerkJS, renders Clerk sign-in when the user is signed out, and renders a self-service token console when signed in. Users can:

- create MCP bearer tokens
- revoke their own MCP bearer tokens
- create local runtime pairing codes
- view their plan, billable usage, throttled attempts, and quota status

On first authenticated Clerk access, the gateway creates a local `free` user linked by `clerkUserId`. The local gateway user remains the source of truth for MCP tokens, pairing codes, plans, quota overrides, and usage. This keeps MCP token verification local and avoids checking every tool call against Clerk.

If `CLERK_FRONTEND_API_URL` is not set, the gateway derives the ClerkJS script origin from `CLERK_PUBLISHABLE_KEY`.

## Usage Tracking

The gateway records every MCP `tools/call` request handled by `/mcp`, including forwarded GSD tools and runtime-advertised tools such as `gsd-browser mcp` tools. Usage records include user ID, tool name, optional runtime/project routing fields, status, duration, billable status, throttle status, and timestamp.

By default, usage is in-memory. Persist aggregate daily counters and the bounded recent-call list with:

```bash
node packages/cloud-mcp-gateway/dist/cli.js --usage-store /secure/path/gsd-cloud-usage.json
# or
GSD_CLOUD_USAGE_STORE_PATH=/secure/path/gsd-cloud-usage.json node packages/cloud-mcp-gateway/dist/cli.js
```

Accepted MCP tool calls are billable and count toward user quotas. Throttled attempts are still tallied, but they are recorded as non-billable so a client that keeps retrying does not make the user's quota counter climb after enforcement has started.

## Free Account Throttling

New self-registered users and users created with the default plan are `free`. The startup seed user is `unlimited` so operators do not lock themselves out while setting up the gateway.

Default limits:

- `free`: 12 calls/minute, 100 billable calls/day, 1,000 billable calls/month
- `paid`: 60 calls/minute, 2,000 billable calls/day, 50,000 billable calls/month
- `unlimited`: no quota checks

Override the defaults with environment variables. Set a value to `0` to make that dimension unlimited:

```bash
export GSD_CLOUD_FREE_CALLS_PER_MINUTE=12
export GSD_CLOUD_FREE_CALLS_PER_DAY=100
export GSD_CLOUD_FREE_CALLS_PER_MONTH=1000

export GSD_CLOUD_PAID_CALLS_PER_MINUTE=60
export GSD_CLOUD_PAID_CALLS_PER_DAY=2000
export GSD_CLOUD_PAID_CALLS_PER_MONTH=50000
```

When a user exceeds quota, `/mcp` returns a tool error such as `Usage limit exceeded`, the runtime tool call is not forwarded, and the denied attempt appears in the admin usage view as `Throttled`.
