# Reference deployment: one person per Linux server

This reference runs Workbench's engine, browser app and terminal broker on one Linux host for one person. It uses separate operating-system accounts for the engine and agents. The deployer supplies TLS, SSO, DNS, account permissions, vendor sign-ins, backups and upgrades.

Use the release's [build instructions](../../BUILDING.md), provenance and checksums to identify and install its exact contents. The setup script configures a host; it does not establish that your installation passed its acceptance checks.

## Layout and accounts

Install `briefing-table/` and `pty-broker/` as siblings under `/opt/workbench`. The engine's local broker dependency must resolve to that included sibling. Install the complete built `web-app/` at `/opt/workbench/web-app`, root-owned and read-only to service accounts. The engine serves that output at `/app`; do not serve `web-ui/` as the generated app.

Install locked dependencies only in `pty-broker`, `briefing-table` and `web-ui/build-tools`, as described in the root build instructions. The preserved package and lockfile at the root of `web-ui/` are source inputs only: **never run npm ci in web-ui itself**.

This source repository keeps the reference files in the top-level `deploy/reference/` directory. For installation, copy them into `/opt/workbench/briefing-table/deploy/reference/`, preserving the measured deployed layout. The script reads unit templates beside itself and uses the fixed engine code path `/opt/workbench/briefing-table`; moving only the script without its templates is insufficient.

| Account | Runs and owns |
| --- | --- |
| wbengine | Engine, identity database, private data and secrets; no interactive login |
| wbagent | pty-broker, every agent it spawns, project folders and vendor logins |

The engine has the agent group's read access to project folders. Agents cannot read engine-private data through this reference's account permissions. Agents sharing the same account are not isolated from one another; they retain that account's files, credentials and network access.

The unit named `workbench-broker.service` runs **pty-broker**. It does not require the separate workbench-broker package. Room tasks and room files are engine features; they need no standalone task or asset service. This deployment needs no fabric, realm, voice service or separate Codex connector.

## File modes

| Path | Ownership and access |
| --- | --- |
| /opt/workbench/briefing-table and /opt/workbench/pty-broker | Installed source and dependencies, root-owned; service accounts must not modify them |
| /opt/workbench/web-app | Complete built app, root-owned, directories0755 and files0644 |
| /var/lib/workbench | Engine-private data, wbengine-owned,0700 |
| /var/lib/workbench-files | Room files, wbengine:wbagent,2770 plus inherited ACLs for both accounts |
| /etc/workbench/*.env | Root-owned,0600; systemd reads them before switching accounts |
| /home/wbagent/dev | Agent project folders, wbagent-owned,0750 with intended engine group read access |

The default ACLs let the engine edit files created by agents and vice versa. Group membership alone does not supply those inherited write permissions. Keep the room-files directory separate from private engine data; neither should contain or enclose the other.

## Install and configure

1. **Prepare the host.** Install the release's supported Node toolchain, native build prerequisites and the `acl` package. Install the source dependencies and built app following the root build instructions. The setup script requires the engine's node_modules directory and setfacl. Its explicit --no-acl option leaves agent-created shared files read-only to the engine; use the ACL setup for the normal reference.
2. **Copy and review the reference setup.** From this source repository's root, copy the reference directory to the measured installed location using the commands below. Run the installed script with --dry-run, inspect the proposed accounts, paths, permissions and units, then run it without --dry-run as the deployment operator. It creates fresh broker credentials and protected environment files and installs both units. It does not start them by default. Inspect its behavior before applying it to an existing host.
3. **Configure the environment.** Edit `/etc/workbench/workbench.env` and `/etc/workbench/pty-broker.env` without exposing their values in logs or source control. Keep engine and broker listeners on loopback. Retain the hosted and strict-identity settings and the separate files root below. Systemd owns this broker, so engine broker autostart stays off.
4. **Configure the network door.** Set the public hostname, allowed hosts, WebAuthn RPID and origin consistently. Configure the TLS proxy and company SSO before granting network access. Every route reachable from the network goes through the SSO proxy, API-token routes included; exempt no paths. Engine and broker ports are not exposed. Test WebSocket forwarding as well as ordinary requests. The proxy examples do not configure your SSO policy or prove production certificate trust. TLS and SSO here are deployment requirements, not measured production PASS claims.
5. **Create the engine account and vendor logins.** Bootstrap the first engine account using the identity command below. Its temporary password belongs only in the operator's terminal. Install and sign in to each vendor program as wbagent. Proxy sign-in, engine identity and vendor login are separate authorities.
6. **Start and verify.** Once configuration has been reviewed, the deployment operator can enable and start workbench-broker and workbench-engine through systemd. Put the reviewed proxy in front, then perform the acceptance checks below with the intended person. Do not reuse another installation's results.

From the source repository root, prepare the installed reference directory and inspect its dry run:

```sh
sudo install -d /opt/workbench/briefing-table/deploy/reference
sudo cp -R deploy/reference/. /opt/workbench/briefing-table/deploy/reference/
sudo bash /opt/workbench/briefing-table/deploy/reference/setup-reference.sh --dry-run
```

The source tree remains split; this copy preserves the measured host path and keeps the script beside its unit and environment templates. Review an existing destination before copying so that local operator changes are preserved. Apply the script without --dry-run only after inspecting its output and the configuration.

Required reference settings include:

```text
HARBOR_WB_HOSTED=1
HARBOR_WB_IDENTITY=strict
HARBOR_WB_NODE=workbench-pilot
HARBOR_WB_APP_DIR=/opt/workbench/web-app
HARBOR_WB_FILES_DIR=/var/lib/workbench-files
HARBOR_WB_PANE_TOKENS=1
HARBOR_WB_PANE_TOKEN_DELIVERY=env
HARBOR_WB_BT_MCP=1
HARBOR_WB_BROKER_AUTOSTART=0
HARBOR_WB_PLUGINS=1
```

Use the supplied examples for the other settings, including loopback binds, ports, protected broker credentials, allowed hosts and public-origin values. The broker requires a bearer of at least16 characters; leave its no-auth override unset. Browser terminals connect through the engine, never directly to the broker.

The first-account command, run by the operator, is:

```sh
sudo -u wbengine env HARBOR_WB_DATA_DIR=/var/lib/workbench \
  node /opt/workbench/briefing-table/node_modules/tsx/dist/cli.mjs \
  /opt/workbench/briefing-table/scripts/identity.ts bootstrap --username owner
```

Choose the intended username instead of the example `owner`. Do not capture the printed temporary password in a shared transcript.

## Identity and network policy

The SSO proxy decides who can reach network routes. The engine separately identifies its own account through password/passkey sign-in or configured OIDC sign-in linked to an engine account. It never treats proxy identity headers as engine identity. A company can use the same identity provider for both layers, but configuring one does not configure the other.

Agent seats reach the engine on loopback using pane tokens, never through the proxy. Allow engine-account outbound HTTPS only to the configured identity provider's pinned issuer endpoints when engine OIDC is used, for discovery, tokens and keys. Otherwise that account needs no egress. Agent vendor and project egress is a separate allow-list supplied by the network owner.

The folder picker's source-defined default is the engine account's HOME or `HARBOR_WB_FS_ROOT`. Configure the intended picker root and filesystem permissions separately. **The picker root limits navigation, not execution. The agent account's OS permissions are the execution boundary.** The engine can save a recipe outside that root, including a relative path, and attempt to start it; the broker's chdir and account permissions decide whether it can run there. A root setting neither grants access nor contains all possible launches. A hosted recipe without a folder is refused: “This agent has no folder yet. Add it again with a folder.” That refusal occurs without spawning a program. Do not silently choose a working directory for it.

For targets intended to run on this engine host, `HARBOR_WB_NODE` must match their node pin in `targets.json`. The examples use `workbench-pilot`. A mismatch makes a seat be treated as remote and omit room tools even when its program launches. Check `seats[].occupant.tools_reason`: `not-local` indicates this node/target identity mismatch.

## Pane credentials and delivery

Claude Code and Codex can join a room. Gemini opens as a terminal. Hosted Codex uses its CLI and engine room tools, not the separate connector package.

When engine and broker accounts differ, `HARBOR_WB_PANE_TOKEN` reaches the agent through the broker's spawn environment only. There is no pane-token file. The room-tool credential helper reads that environment; do not embed a literal bearer in MCP configuration or a URL. Same-account processes can read that account's environment. Keep the engine master credential outside agent reach.

App-started seats are persistent. In an OPEN room, the reaper protects a persistent seat and it keeps listening for room doorbells with every browser page closed. Panes that are streaming or waiting are also protected. The agent pulls through room_read before replying; an attached browser viewer is not required.

An eligible non-persistent, windowless pane can be dehydrated after the configured timeout and restored later, with “resting · Wake it” shown. The default timeout is 60 minutes, not an unconditional lifetime limit. A saved configuration value takes precedence over `HARBOR_WB_REAP_MS`; inspect both when changing the timeout. Verify the actual app/native-agent, room state and restart behavior on your installation.

A real-home launch inherits that account's native vendor settings. Claude's permission mode is independent of engine auto-approve. The source-supported trust contract permits explicit folder pre-accept only for a self-hosted local launch where the engine can write its own Claude configuration; it does not pre-accept another account's trust dialog in this split-account setup. The person answers that dialog. This contract and the picker's HOME default are not measured deployment acceptance; validate the intended account and folder behavior yourself.

## Tools and Handbook

The reference enables tool installation with `HARBOR_WB_PLUGINS=1`: people can install a zip and each tool asks for consent. Set it to0 to disable installation. Enabling installation does not grant blanket access. Changed installed files can place a tool on hold.

Remove retains an engine-private backup at `<engine-data>/plugins/.backup-<id>-<time>` (0700). Only the server operator can read or delete it, not agent accounts. Removal is not a purge guarantee.

Read the built app's manifest for its bundled catalog. An example tool zip is not installed merely because it is distributed. The app sandbox does not make untrusted tools safe to read data the person grants them.

The Handbook tool is enabled by default; `HARBOR_WB_HANDBOOK=0` removes it. Keep `briefing-table/docs/handbook/`, or a `HARBOR_WB_HANDBOOK_DIR` override, deployer-owned and not writable by agents. Put no secrets there. Its versioned manifest identifies the shipped topics.

## Acceptance checks and limits

Record the release's content identities and actual outcomes for this installation. Check:

- Engine and broker account identities, loopback-only listeners and network denial of direct access.
- Engine-private files and environment files denied to the agent account; intended project and room-file access working in both directions.
- TLS, SSO on every network route, engine sign-in and authenticated WebSockets.
- The complete installed app against its manifest, including terminal runtime files and bundled tools.
- Real Claude and Codex started through the app, with their room pull/reply and any native prompts recorded; distinguish those from stand-in plumbing tests.
- No-folder refusal without a program spawn, and the intended Start, restore and closed-page delivery behavior.
- Handbook default, override and off states; tool zip check, consent, install, reload, changed-file hold and Remove.
- Safe file downloads, forced downloads for active content, MIME/nosniff headers and the applicable app or sandbox response policy.

A source build, unit count, proxy syntax check, manifest match or stand-in pane is not proof of all these properties. Follow the release's evidence limits; do not turn an unperformed native-agent, production SSO or restore check into a pass.

## What you still own

Back up consistent engine databases, protected identity and secrets, room files, project/home data and deployment configuration. **Take a consistent database and configuration backup before each upgrade.** The operator must define a consistent backup method and recovery procedure for this deployment, including what is stopped or snapshotted, and preserve ownership and access rules. **Rehearse restoration in an isolated instance before relying on the backup.** This reference supplies no validated backup procedure and reports no completed restore drill. A backup does not preserve a live terminal process or prove conversation recovery.

A broker restart ends its held sessions. Distinguish it from restarting the engine and plan upgrades accordingly. Credential rotation, revocation, retention, backup protection and vendor authentication remain operator responsibilities.

The supported deployment is one person per instance. Several people can use independent instances with separate origins, state, credentials and backups. Multiple engine accounts on one instance do not implement per-owner process isolation or send-as authorization. The account split protects engine-private files; it does not sandbox agents sharing the same agent account.
