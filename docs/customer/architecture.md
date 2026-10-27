# Agent Workbench: customer architecture (hosted, web-first)

This document describes the architecture we recommend for running Agent Workbench on your own
Linux server: which parts we deliver and which you build, every seam between them, and how to
stay aligned as both sides change. It describes the release in this repository. Where something
is not built yet, it says "planned". Where something is the deployer's job, it says so.

Its companions, the residual-risk statement and the multi-agent threat statement, are supplied
separately with the security-review response; they are not in this repository. For a
reviewer's starting point see [for security reviewers](../for-security-reviewers.md); for
reporting a vulnerability see the [security policy](../../SECURITY.md).

Words used here:
- **engine:** the room engine in this repository.
- **broker:** the PTY host that holds agent terminals.
- **person:** a human user.
- **agent:** a vendor CLI (Claude Code, Codex) running in a seat.
- **seat:** an agent's place in a room.
- **deployer:** you.

## 1. The shape in one picture

```
 person's browser
     │  HTTPS (your TLS, your SSO)
     ▼
 ┌──────────────────────┐   your reverse proxy: TLS termination, SSO / OIDC front door,
 │  reverse proxy        │   request limits. Forwards to the engine on loopback only.
 └──────────┬───────────┘
            │ http://127.0.0.1:<engine port>
            ▼
 ┌──────────────────────┐   OS account: wbengine (a service account, no login shell)
 │  ENGINE               │   rooms, seats, lines, identity, web UI, recipes, approvals,
 │  (this repository)    │   per-room Scratchpad files. SQLite under its data dir.
 └──────────┬───────────┘
            │ ws://127.0.0.1:<broker port>/broker  + bearer (one per person)
            ▼
 ┌──────────────────────┐   OS account: the PERSON's own account (e.g. alice)
 │  BROKER (per person)  │   holds the person's agent terminals; survives engine restarts
 │   └─ agent CLIs       │   Claude Code / Codex run here, logged in with the person's
 │      (seats)          │   OWN vendor credentials, in the person's own workspace
 └──────────────────────┘
```

**One server = one engine.** The supported shape for this release is **one person per server**.
Several people per server is the target shape (§6): one broker per person, under that
person's own OS account. Nothing else is required: no message fabric, no realm service, no
telemetry bus, no desktop client.

## 2. What we deliver, and what you build

| Area | We deliver (this repository and its docs) | You build and operate |
|---|---|---|
| Engine and web UI | The engine, the web UI it serves, its tests, the shipped proof suites (see [building](../../BUILDING.md)) and a [reference setup](../../deploy/reference/README.md) | Installing, upgrading and backing up the engine |
| Identity | Engine accounts, passkeys, strict identity mode, sessions, an OIDC relying party (§4.2) | **SSO** in front of the engine and its policy (who may sign in); creating accounts |
| Transport | Loopback-only bind; Origin, Host and content-type checks; frame-ancestors | **TLS** and the reverse proxy |
| Agent hosting | The broker protocol, launch rules and per-seat recipes | **OS accounts** (§3) and **hosting each person's broker** |
| Vendor access | Seats that use whatever vendor login exists in the person's account | **Vendor licences** and each person's own vendor sign-in (§5) |
| Agent safeguards | Vendor safeguards ON by default: auto-approve is a visible per-recipe opt-in; folder trust is per folder | Your policy on whether people may opt in |
| Files | Per-room Scratchpad under a files root you configure, served only to signed-in people | Disk, quotas, retention policy (M12), backups |

## 3. OS accounts and file ownership (R7)

The rule this design rests on: **an agent can never read or write what the engine trusts.**

| Account | Runs | Owns | Must NOT be able to read or write |
|---|---|---|---|
| `wbengine` (service, no login) | the engine | `<data>/` (`data/mapping.db`, `data/identity.db`, `secrets/engine.token`), all modes 0600/0700 | any person's home |
| `<person>` (one per person) | that person's broker and every agent in it | `~<person>/` (workspace, vendor logins such as `~/.claude`) and `~<person>/.workbench-broker/broker.token` | the engine's data dir and token; other people's homes and broker tokens |

The [reference setup](../../deploy/reference/README.md) builds this layout for one person, with
the accounts named `wbengine` (engine) and `wbagent` (the person's broker and agents).

Notes:
- **The engine token never enters an agent's environment** (finding H6). That alone does NOT
  stop a same-uid FILE read. The token and the engine's data are unreadable from an agent ONLY
  when the engine runs under a different OS account from the agents, as in this table. That
  account split is built by the deployer (R7). If engine and agents share a uid, H6 is
  mitigated, with a residual (stated in the residual-risk statement), not closed. Agents talk
  to the engine only through their own **pane token** (§4.4).
- **A person's agents CAN read that person's broker token** (same uid). This grants nothing
  new, because they already run as that uid. It is stated in the residual-risk statement.
- **The approval record (§7) lives in the engine's database,** which no agent can write under
  this layout. This is what makes R11's "the agent cannot write the approval" true.
- **This differs from the single-account hosted layout** made by the helper script
  `briefing-table/scripts/hosted-workbench.ts` (engine and broker as the same user). That
  layout is fine for a personal instance, and is NOT the recommended layout for a company.
  Like the company layout, it pre-trusts no Claude folder unless the deployer names one with
  `--trust-folder <dir>` (H3).

## 4. Seams and contracts

Each seam has an owner, a version signal, and a rule for changing it.

### 4.1 Browser ↔ engine (HTTP + WebSocket)
- **Contract:** events from the engine to the browser and commands from the browser to the
  engine over the engine's WebSocket, plus the REST routes the web UI uses.
- **Version signal:** `GET /api/node` (signed in) returns `protocolVersion` and
  `engineVersion`.
- **Security properties (proof suites):**
  - every state-changing request and every WebSocket upgrade checks Origin and Host against
    an allow-list (H5);
  - state-changing bodies must be `application/json`, EXCEPT the named authenticated upload
    routes, which keep the Origin/CSRF checks (H5):
    - room-file uploads are a raw-body `POST` with an `x-filename` header;
      it never overwrites (a clash is saved as `name-1.ext`);
    - a conditional `PUT` that replaces a file echoes the file's `ETag` in `If-Match`. The ETag is
      a quoted SHA-256 of the content, opaque to clients; a stale or deleted file answers 412;
    - the plugin zip upload is a separate contract (multipart or a raw zip, behind
      `HARBOR_WB_PLUGINS`);
  - pages send `frame-ancestors 'self'` and `X-Frame-Options` (M14). Sign-in, 401, redirect
    and engine HTML responses carry the framing headers only; a script Content-Security-Policy
    on those responses is planned;
  - unauthenticated routes return status only (L5);
  - redirects after sign-in stay on the engine's origin (L4);
  - uploaded files never run script: SVG and HTML attachments are served as downloads, with
    `nosniff` and a sandboxing policy (L2).
- **The web UI** is served by the engine on the SAME origin (under `/app`), with ONE
  Content-Security-Policy header. Its browser-side `window.wb` layer forwards engine
  operations to the engine, and uses browser substitutes for clipboard, tabs and
  notifications. Terminal transport is a WebSocket through the engine. There are no
  Electron privileges, no native preload bridge and no local-filesystem authority in the
  browser.
- **Deployer setting:** the engine's public origin, so the Origin allow-list and passkeys
  (`HARBOR_WB_WEBAUTHN_RPID` / `HARBOR_WB_WEBAUTHN_ORIGIN`) match your hostname.

### 4.2 Identity and SSO
- **Engine side:** `HARBOR_WB_IDENTITY=strict` means no shared bearer for people. Accounts
  carry passwords and/or passkeys.
- **Where a person counts as a person:** person-only actions (approvals, restarts, settings)
  require an identity session or device; they never accept a token an agent could hold.
- **SSO:** put your IdP in front through the engine's OIDC relying party (`HARBOR_WB_REALM_*`
  variables: one pinned issuer, PKCE, a confidential client with its secret in a file).
  Today an OIDC identity must be LINKED to an existing engine account. Automatic account
  creation keyed on your IdP's immutable user id, and role mapping from IdP app roles, are
  planned (designed, not built).
- **No exempted paths:** every route reachable from the network goes through your SSO proxy,
  API-token routes included, and the engine stays bound to loopback. A path the proxy lets
  through unauthenticated leaves the engine's own remembered devices and API tokens as the only
  gate. Agent seats are unaffected: they reach the engine on loopback with their pane tokens,
  never through the proxy.
- **Never trust identity headers from the proxy:** behind a proxy every request arrives from
  loopback, and anything on the box can write a header. The engine never reads
  proxy-injected identity headers, and you must not add that.
- **Local engine accounts have a credential limit.** On accounts held by the engine itself
  (password or passkey, including a break-glass admin), changing the password ends the
  account's sessions but NOT its remembered devices or API tokens, and an API token can mint
  its successor. Until the planned fix (a password change revokes all of the account's
  credentials; a token can't mint a token): put every person behind SSO, keep local accounts
  to a break-glass admin, and after a suspected compromise revoke that account's remembered
  devices and API tokens explicitly (Account settings), not only its password.

### 4.3 Engine ↔ broker
- **Transport:** WebSocket on loopback, with a bearer per broker (`HARBOR_WB_BROKER_TOKEN_FILE`
  on the engine side, `PTY_BROKER_TOKEN` on the broker side).
- **Required broker behaviour (H7):**
  - it refuses to start without a token;
  - it rejects any request carrying an Origin header (so browsers can't reach it);
  - it compares tokens in constant time, with no token in the URL;
  - it bounds frame size.
- **Version signal:** the broker's `/health` reports its protocol version, and the engine
  checks it on connect.
- **The broker protocol is FROZEN** and changes only through us. A broker restart ends every
  session it holds, so restart brokers only in maintenance windows. The engine can restart
  freely: the broker keeps the sessions alive.

### 4.4 Agent ↔ engine (pane tokens and room tools)
- **One pane token per agent process.** It is minted at launch and dies with the process. It
  is never on the command line, in an MCP config, or typed. The engine's built-in default
  delivers it as a 0600 file in the engine's account, with only the file's PATH in the agent's
  environment. In the recommended split-account layout (§3), set
  `HARBOR_WB_PANE_TOKEN_DELIVERY=env` (the reference setup does): the token then rides only
  the person's broker spawn environment, and no file is written.
  **Measured** on a clean Ubuntu 24.04 VM with the reference layout (engine as `wbengine`,
  broker as `wbagent`):
  - the agent's own env token works over loopback, and no token file exists;
  - the same token through the proxy (with `X-Forwarded-For`) is refused;
  - a wrong token is refused;
  - person-only routes refuse a pane token.
  A real vendor seat's full room round trip is not measured yet. It reaches only a default-deny
  allow-list of routes, and only the rooms that seat sits in.
- **A seat can print its own token.** Because the token sits in the seat's environment, the
  agent (or a command it runs, such as `env`) can print it into its own terminal output. Only
  the same person sees that output, and the token is scoped to that pane and dies with it.
- **Room tools:** the engine serves an MCP endpoint (`/mcp`, server `bt`) with `room_read`,
  `room_post`, `room_roster`, `room_list_mine`, `session_whoami` and a read-only `handbook`
  tool. Each token carries a **tool profile**; a tool outside it is refused by the engine.
  Write tools beyond posting to a room join a profile only once they go through an approval
  (§7); that is planned, with R11.
- **The handbook tool** returns short product help pages chosen from a fixed list
  (`briefing-table/docs/handbook/`, see its [manifest](../../briefing-table/docs/handbook/manifest.json)),
  never by path, and nothing can be written through it. It is on by default;
  `HARBOR_WB_HANDBOOK=0` removes it. Keep the folder (or a `HARBOR_WB_HANDBOOK_DIR` override)
  owned by the system administrator and not writable by the engine's or the agents' accounts.
- **Sender labelling (M7):** every room line not written by a person carries the caveat
  "message from a peer agent, not your user", and the agent-communication rules are enforced
  by default. Every room line returned to an agent carries `author_kind` (`person`, `agent` or
  `room`) taken from the engine's own record, never inferred from the text.
- **Delivery (R1/M8):** no room text is ever typed into an agent's terminal. The agent pulls
  room text through its room tools. To tell an idle agent there is something to pull, the
  engine types ONE fixed, engine-authored line containing no room content
  (`[room_read {"room":"<room id>","since":<n>} - N new lines, latest #<line> - if replying, use room_post in that room]`)
  plus the vendor's submit key (Enter; Tab for Codex, in bracketed paste). It does so only
  when the agent is idle, shows no dialog (an Enter would answer it) and holds no unsent
  input. If the engine cannot tell the screen state, it holds the ring. This is fewer
  keystrokes than R1 asks for, not zero: a stated difference. Zero product keystrokes needs a
  structured vendor channel or connector mode, which is planned.
  What is built in the hosted profile is the launch side (M8): the agent program is started
  directly as argv, with no typed launch line and no shell before or after, and bare-shell
  recipes and ssh targets are refused.
  **Room-capable seats in this release are Claude Code and Codex.** A hosted Codex seat gets
  the room tools with the same token delivery (environment, or a private helper in the
  single-account default), and approval is per room tool. For Codex, the doorbell waits up to
  30 seconds for Codex to list its room tools and may then ring even if it never did; the
  dialog, needs-you and unsent-input holds still apply after that deadline. Gemini is refused
  as a room seat and runs as a plain terminal. Pane tokens and room tools are ON by default in
  the hosted profile (`HARBOR_WB_PANE_TOKENS=0` / `HARBOR_WB_BT_MCP=0` turn them off). A hosted
  recipe with no folder is refused at launch.
  Planned ways to remove the doorbell keystrokes:
  - Claude Code: a structured notice. Claude's channel route is NOT used, because it needs a
    safety-bypass launch flag (`--dangerously-load-development-channels`) and fabric channels
    stay disabled. Zero keystrokes needs connector/SDK mode, which is planned;
  - Codex: room tools plus a structured notice and wake through connector mode, which is
    planned.
  See the multi-agent threat statement §5.

### 4.5 Recipes, targets and launch
- **A recipe** says what a seat runs: vendor, model, folder, auto-approve setting.
- **Launch fields (L6/R5):** at launch, the model name and resume name are reduced to plain
  characters (shell syntax is stripped). In the hosted profile a launch line that would need a
  shell is refused. Refusing bad values when a recipe is SAVED is planned.
- **Auto-approve:** a global DEFAULT for new recipes (chosen at first run, disclosed, off
  unless chosen), plus a per-recipe `follow | on | off`. Imported recipes always land as
  `follow`. The effective value is shown in Settings and takes effect at the seat's NEXT
  launch (H1).
- **Codex hook review (H2):** in the hosted profile the engine writes NO hooks file into any
  project, and never passes Codex's hook-trust bypass. Codex's own review of repository hooks
  therefore always applies. The cost: Codex activity rings driven by hooks are off in hosted
  mode.
- **Claude folder trust (H3):** the engine trusts a Claude folder only if the person has put
  it on the trust list (Settings), which is empty by default. Hosted provisioning pre-trusts
  nothing unless the deployer passes `--trust-folder <dir>` for a specific folder. In the
  split-account layout the engine does not pre-accept another account's trust dialog; the
  person answers it.

### 4.6 Files (Scratchpad)
- **Per-room notes, assets and files,** served by the engine only to signed-in people. Never a
  shared or public folder. The split into `notes/`, `assets/` and `files/` is a convention,
  not a security boundary: a person may write in all three, and new folders are created
  through an owner-confirmed `POST`.
- **Where they live, and who reads them:** by design, a room's agents can read its files.
  As built:
  - The root is `<HARBOR_WB_FILES_DIR>/rooms/<room-id>/{notes,assets,files}/`. Message
    pictures and the room's Assets are the same files (hosted rooms).
  - **If `HARBOR_WB_FILES_DIR` is unset, the root defaults to INSIDE the engine's private data
    dir.** In the recommended layout you MUST set it to a separate folder; otherwise giving
    agents read access would expose the engine's private data. Neither folder may contain the
    other.
  - The ENGINE's account creates the files the engine writes, not the person's account.
  - For a person's agents to reach them, the deployer makes the folder group-shared: a group
    holding the engine account and that person's account, with the setgid bit on the
    directory so new files inherit the group. This is a deployer step. The reference setup
    also sets inherited ACLs so the engine and the agents can each edit files the other
    created.
  - The engine's database, token and secrets stay in its private data dir, unreadable from
    any person's uid (§3).
- **Agents never get a path into the engine's private data dir,** provided
  `HARBOR_WB_FILES_DIR` is set as above.

### 4.7 Tools and plugins (modules)
- **Contract:** the tool and plugin developer guide is supplied separately. It covers:
  - built-in modules vs plugins, and `module.json` / `actions.json` as the engine checks them;
  - permissions, with the gated ones marked;
  - the host API, the sandbox and its CSP, the file types served, and the postMessage bridge;
  - engine and app admission, person consent, and zip packaging with its caps and refusals.
- **The switch:** plugin install is controlled by `HARBOR_WB_PLUGINS`. The engine's built-in
  default is OFF (the install routes answer 404). The reference configuration turns it ON
  (`HARBOR_WB_PLUGINS=1` in the supplied environment file); remove the line or set it to `0`
  to turn installing off. Install is for person accounts only; a pane token is refused.
- **Security properties:** when on, the engine checks the plugin zip (zip reader, file list,
  tree hash), shows a consent screen, and installs with a one-use token. Module and plugin
  pages run in a sandbox with their own CSP (`sandbox allow-scripts`, `connect-src 'none'`),
  never the app's policy, with no same-origin access. They talk only through `postMessage` to
  host calls the engine admits per module, per room and per grant. Every served file is
  re-hashed against the installed tree, and a changed file puts the tool on hold. Each
  module's store is capped at 2 MB.
- **What remains:** a plugin a person installs can read whatever its granted host calls return
  (its room's tasks and files), and it can send that data to any website by navigating its own
  frame; the control is the consent screen and the narrow grant scope, not the sandbox. The
  re-hash proves files haven't changed since consent only if agents can't write the engine's
  data dir (§3). The residual-risk statement covers this.

## 5. Vendor licences and logins (M13)
- **Each person signs in to each vendor CLI in their OWN account** (for example by running the
  vendor's login command in a terminal seat). No vendor login is shared between people.
- **Whether a person's plan permits use through this product** is between you and the vendor.
  We can't certify it.
- **Vendor CLIs are not bundled.** Each person installs them in their own account. Re-run the
  proofs when you upgrade a vendor CLI: vendor trust and approval behaviour can change.

## 6. Growing past one person per server
- **One broker per person,** each under that person's account (§3). The engine holds one link
  per person and authorises every session by OWNER: a person sees and drives only their own
  sessions (H6).
- **The current engine model is "every signed-in account sees every session"**, which is
  acceptable only for one person per server. Per-owner authorisation is planned and gates the
  multi-person shape. Until then, the engine refuses terminal access while more than one
  person account exists.
- **Optional components** (the message fabric for cross-server agent messaging, a central
  realm for accounts) are NOT part of the recommended deployment. Each has its own review
  findings to close before use.

## 7. Approvals: direction (R11, R12)
**Today:**
- **Person-confirmed actions are sign-off RECORDS** in the engine database: bound to the exact
  verb and arguments, single use, expiring, worded by the engine (not by the agent), and
  answerable only by a signed-in person. "Not writable by the agent" holds only with the §3
  account split.
- **High-risk verbs** will require a fresh passkey step-up (planned).

**Direction (R11), planned:**
- **Each vendor's own permission request is routed to a sign-off record:**
  - Claude: a permission hook installed through MANAGED settings that agents cannot edit;
  - Codex: the app-server approval request in connector mode.
- **No record means deny; a timeout means deny.** The product never answers a prompt by
  typing.
- **Each vendor and version must be shown to keep the gate** while its own auto or bypass mode
  is on, before we claim it.

**Direction (R12), planned:**
- **Class leases:** a time-boxed grant for a machine-checkable class (named commands and argv
  constraints inside the workspace; any shell operator is rejected), plus a hard-deny list
  (secrets, the gate's own configuration, hook and settings files, privilege escalation, SSH
  material).
- **A lease is only meaningful together with the OS-account containment in §3.** We build it
  after §3 is in place.

## 8. Staying aligned
- **Don't patch the engine to fit your environment.** Use its configuration (environment
  variables, `config.json`, `targets.json`) and the seams above. If a seam is missing, ask for
  it.
- **Pin a release.** Identify it with the [provenance](../../PROVENANCE.md) and checksums, and
  build it as described in [building](../../BUILDING.md). Check `protocolVersion` (browser
  contract) and the broker protocol version on every upgrade. The shipped proof suites are
  source proofs, not a test of your installation; run the acceptance checks in the
  [reference setup](../../deploy/reference/README.md) on your own install.
- **The frozen pieces:** the broker protocol, the pane-token allow-list (default deny), and
  the sign-off record's rules. Changes come from us, with a version bump.
- **Report drift:** if your proxy, SSO or OS layout differs from §1–§3, record it beside your
  deployment. Most items in the residual-risk statement depend on the §3 layout.

## 9. Fitting into your network

The step-by-step setup (accounts, file modes, environment, proxy and SSO requirements,
acceptance checks, backups) is in the [reference setup](../../deploy/reference/README.md). This
section states the boundaries those steps must keep.

### 9.1 The pilot shape: one person, one server
```
 company network / VPN
   │  443/TCP (HTTPS)  ← the ONLY inbound port
   ▼
 ┌─ server ─────────────────────────────────────────────────────────┐
 │ reverse proxy + SSO (yours) ──http──▶ engine 127.0.0.1:<engine>   │
 │                                         │ ws + bearer             │
 │                                         ▼                         │
 │                                   broker 127.0.0.1:<broker>       │
 │                                         │ (person's OS account)   │
 │                                         └─ agent CLIs ──▶ outbound│
 │                                            room tools: loopback   │
 │                                            to the engine          │
 └──────────────────────────────────────────────────────────────────┘
```

### 9.2 Ports and flows
| Flow | From → to | Port / scheme | Rule |
|---|---|---|---|
| People | browser → your proxy | 443, HTTPS | The only inbound port. Your SSO authenticates EVERY route the proxy forwards; no exempted paths. |
| Proxy → engine | proxy → engine | loopback HTTP, engine port | The engine binds 127.0.0.1 only. Set the engine's public origin and allowed hosts to your hostname (§4.1). |
| Engine → broker | engine → person's broker | loopback WebSocket, broker port, bearer | Loopback only, with a token; never forwarded by the proxy. |
| Agents → engine | agent CLIs → engine | loopback HTTP, pane token | Room tools and the handbook. Never through the proxy. |
| Agents → vendors | agent CLIs → vendor APIs | outbound HTTPS | The vendor endpoints your licences use (Anthropic for Claude Code, OpenAI for Codex), plus whatever an agent's own work needs (package registries, your Git server). This is the egress you allow-list. |
| Engine → your IdP | engine → your OIDC provider | outbound HTTPS | ONLY if you use the engine's own OIDC sign-in (§4.2): discovery, token and key endpoints of the one pinned issuer. Allow just that host. |
| Engine → anywhere else | — | none | Otherwise the engine makes no outbound calls in the hosted profile (no telemetry, update checks or fabric). |
| Backups | your backup system → server | yours | See 9.4. |

**Never expose:** the engine port, the broker port, or any `HARBOR_WB_*` token or env file.
Nothing listens on a non-loopback address except your proxy.

**Two sign-in layers, and how they combine.** Your SSO proxy decides who reaches the server at
all, and it covers every route (no exempted paths). Separately, the engine needs to know WHICH
engine account a request belongs to. That comes either from the engine's own sign-in (password
or passkey) or from the engine's OIDC sign-in against your IdP (§4.2), which links an IdP
identity to an engine account. The engine never takes identity from proxy headers. A typical
company setup uses both: the proxy for the network door and the engine's OIDC sign-in, against
the same IdP, for the account.

### 9.3 DNS and TLS
- One hostname (for example `workbench.example.internal`) points at the server.
- Your proxy terminates TLS with your certificate. Passkeys and the Origin checks are bound to
  that hostname (`HARBOR_WB_WEBAUTHN_RPID`, `HARBOR_WB_WEBAUTHN_ORIGIN`, `HARBOR_WB_ALLOWED_HOSTS`),
  so changing the hostname is a reconfiguration, not a DNS-only change.
- The browser needs HTTPS: clipboard and passkeys don't work over plain HTTP.

### 9.4 What to back up
| What | Where | Note |
|---|---|---|
| Engine data | the engine data dir (`mapping.db`, `identity.db`, secrets) | Stop or snapshot consistently; contains accounts, approvals and room history. |
| Room files | the files root (`HARBOR_WB_FILES_DIR`) | Person-visible notes, assets and files. |
| Agent work | each person's workspaces and home | The person's own code, vendor logins and agent transcripts. Your normal workstation/server policy. |
| Configuration | the root-owned env file and the handbook folder | Re-creatable from your deployment config. |

### 9.5 Trust boundaries
- **Network → server:** your proxy and SSO decide who reaches the engine at all.
- **Proxy → engine:** the engine still checks every request itself (sign-in, Origin, Host,
  JSON-only bodies; H5) and never trusts identity headers from the proxy (§4.2).
- **Engine → agents:** agents hold only their own pane token, which reaches a default-deny set
  of routes for their own rooms (§4.4). They never hold the engine's token or a person's
  session.
- **Agents → the rest of your network:** NOT limited by Agent Workbench. An agent can reach
  whatever its OS account and your egress rules allow. Contain it with the OS-account layout
  (§3) and your firewall, not with the product.

### 9.6 Several people or several servers
| Shape | Status | What it needs |
|---|---|---|
| One person per server | **Supported** | This section as written. |
| Several people on one server | **Not supported yet** | Per-owner authorisation of sessions (H6), which is planned: until then every signed-in account can see every session, and the engine refuses terminal access while more than one person account exists. Each person also needs their own OS account and broker (§3, §6). |
| Several servers, one per person | **Supported as N independent installations** | Each server is its own engine, hostname, SSO client and backup. Rooms, seats and files do NOT span servers; agents on different servers can't share a room. |
| Rooms that span servers, a central account service, or agents acting as a person on another server | **Not built** | The optional message fabric and realm components and send-as credentials (H10) are not part of the recommended deployment and have open review findings. |
