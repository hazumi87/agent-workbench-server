/**
 * Scratch ports and a scrubbed child env for every test that boots an engine,
 * a pty-broker or a stub server. room interface T0 [ticket].
 *
 * WHY. Suites used to hard-code their ports, and several shared them. A port
 * one suite treats as a DEAD broker (nothing listens, so no pty is ever opened)
 * is a LIVE broker in another, so two suites run at once did not collide with
 * EADDRINUSE: the "no broker" engine silently ADOPTED the other suite's
 * sessions. And a suite launched from a CLI-Manager pane inherited
 * PTY_BROKER_HOST (the tailnet address) + PTY_BROKER_TOKEN (a real bearer),
 * so its scratch broker bound the tailnet with a real token, the engine never
 * reached it, and the suite bailed and exited 0 with no assertions run.
 *
 * THE RULES.
 *   - Every scratch port is P(n) = 7430 + n + WB_TEST_PORT_OFFSET. At offset 0
 *     each suite gets exactly the port it hard-coded before T0. Concurrent runs
 *     (two worktrees, two agents) take different offsets, in steps of 100.
 *   - P() refuses the live ports: 7430 (the REAL pty-broker), 7420 (the
 *     engine / VRPC shim), 8200 (window host), 8201 (the server engine), 8204
 *     (the message fabric). No offset can walk a test onto one of them.
 *   - assertFree(port) binds and releases 127.0.0.1:<port> before the suite
 *     uses it, so a leaked process from an aborted run is NAMED, not adopted.
 *   - Every child is spawned with childEnv(): PTY_BROKER_* and HARBOR_WB_* are
 *     stripped, the path is set under exactly one key, fabric + NATS are off.
 *
 * PORT TABLE (n -> port at offset 0 -> who uses it). Shared rows are shared by
 * suites that never run at the same time inside one runner invocation (the
 * runner is sequential); concurrent runs are separated by the offset.
 *    1  7431  engine.test.mjs            engine
 *    2  7432  engine.test.mjs            fake window host (stands in for :8200)
 *    3  7433  identity-engine.test.mjs   engine
 *             window-agent.test.mjs      engine
 *    4  7434  passkey-browser.probe.mjs  engine
 *    5  7435  fabric-inbound.test.mjs    engine
 *    6  7436  fabric-subscriber.test.mjs engine
 *             identity-introspect.test   engine (legacy phase)
 *             shell-tabs.probe.mjs       engine
 *    7  7437  identity-introspect.test   engine (strict phase)
 *             v21-shell.probe.mjs        engine
 *    8  7438  v21-ui.probe.mjs           engine
 *    9  7439  (free; old comments name it for a retired broker test)
 *   10  7440  engine.test.mjs            LIVE scratch broker (local link)
 *             v21-ui.probe.mjs           LIVE scratch broker
 *   11  7441  engine.test.mjs            LIVE scratch broker ("testhost" link)
 *   12  7442  fabric-inbound.test.mjs    LIVE scratch broker
 *             identity-engine.test.mjs   DEAD broker port (nothing may listen)
 *             window-agent.test.mjs      DEAD broker port
 *   13  7443  fabric-subscriber.test.mjs LIVE scratch broker
 *             passkey-browser.probe.mjs  DEAD broker port
 *             shell-tabs.probe.mjs       DEAD broker port
 *             v21-shell.probe.mjs        DEAD broker port
 *   14  7444  fabric-subscriber.test.mjs stub fabric (stands in for :8204)
 *             identity-introspect.test   DEAD broker port (legacy phase)
 *   15  7445  identity-introspect.test   DEAD broker port (strict phase)
 *   16  7446  agent-fs.test.mjs          engine
 *   17  7447  agent-fs.test.mjs          DEAD broker port
 *   18  7448  IN USE TODAY, not allocated here: manager-color.probe.mjs and
 *             manager-escape.probe.mjs point at an engine someone started
 *             by hand on :7448. They boot nothing, so they do not use P().
 *  20-29 7450-7459  RESERVED for test/voice.test.mjs (sibling branch).
 *   30  7460  rooms-routes.test.mjs      engine (workrooms T3)
 *   31  7461  rooms-routes.test.mjs      DEAD broker port
 *   32  7462  manager-rooms.probe.mjs     engine (rooms as groups + hide)
 *   33  7463  manager-rooms.probe.mjs     DEAD broker port
 *   35  7465  room-voice-e1a.test.ts     engine (voice credential gate, identity both)
 *   36  7466  room-voice-e1a.test.ts     DEAD broker port
 *   37  7467  room-voice-e1a.test.ts     DEAD the voice service port (HARBOR_WB_VOICE_URL; nothing may listen)
 *   40  7470  rooms-ws.test.mjs          engine (workrooms T5)
 *   41  7471  rooms-ws.test.mjs          DEAD broker port
 *   42  7472  ws-liveness.test.mjs       engine (workrooms T5)
 *   43  7473  ws-liveness.test.mjs       LIVE scratch broker
 *   44  7474  room-cycle.probe.mjs       engine (room disconnect / reconnect UI)
 *   45  7475  room-cycle.probe.mjs       DEAD broker port
 *   46  7476  room-cells.probe.mjs       engine (room panel cells)
 *   47  7477  room-cells.probe.mjs       DEAD broker port
 *   48  7478  manager-card-mark.probe.mjs engine (the project mark behind the card title)
 *   49  7479  manager-card-mark.probe.mjs DEAD broker port
 *   50  7480  room-roster.probe.mjs      engine (workrooms T6)
 *   51  7481  room-roster.probe.mjs      DEAD broker port
 *   52  7482  rooms-reach.probe.mjs      engine (room front end, item 1)
 *   53  7483  rooms-reach.probe.mjs      DEAD broker port
 *   54  7484  (hand-run) a branch engine cli-manager leaves up for the design system
 *             Playwright review; not a suite
 *   55  7485  (hand-run) its DEAD broker port
 *   56  7486  room-add.probe.mjs         engine (room front end, item 2)
 *   57  7487  room-add.probe.mjs         DEAD broker port
 *   58  7488  room-nav.probe.mjs         engine (room front end, item 3)
 *   59  7489  room-nav.probe.mjs         DEAD broker port
 *   60  7490  agent-slug-derive.test.ts  engine (booted twice on one seeded table)
 *   61  7491  agent-slug-derive.test.ts  DEAD broker port
 *   62  7492  room-reads.probe.mjs       engine (room front end, item 4)
 *   63  7493  room-reads.probe.mjs       DEAD broker port
 *   64  7494  rooms-roster.test.mjs      engine (roster verbs: actions/start)
 *   65  7495  rooms-roster.test.mjs      DEAD broker port
 *   66  7496  rooms-roster.test.mjs      stub fabric (/presence only)
 *   67  7497  room-actions.probe.mjs     engine (room front end, item 6)
 *   68  7498  room-actions.probe.mjs     DEAD broker port
 *   69  7499  IN USE TODAY, not allocated here: broker-available.test.ts
 *             names it as a dead local link. It is never bound, and that
 *             suite boots nothing, so it keeps its literal.
 *   70  7500  fabric-send.test.mjs       main engine (fabric enabled, url
 *             points at the stub fabric)
 *   71  7501  fabric-send.test.mjs       dead broker port, shared by BOTH
 *             engines this suite boots (never bound; a broker client dialling
 *             it needs no exclusivity)
 *   72  7502  fabric-send.test.mjs       stub fabric (stands in for :8204;
 *             stopped/restarted mid-suite to produce the unreachable case)
 *   73  7503  fabric-send.test.mjs       second engine (fabric DISABLED,
 *             HARBOR_WB_FABRIC_URL='')
 *   74  7504  fabric-checkin.test.mjs    main engine (check-in + F4 room threads)
 *   75  7505  fabric-checkin.test.mjs    dead broker port, shared by both engines
 *   76  7506  fabric-checkin.test.mjs    stub fabric (/checkin /bind /send
 *             /threads /threads/:id/acks; stands in for :8204)
 *   77  7507  fabric-checkin.test.mjs    second engine (HARBOR_WB_ROOM_FABRIC=0)
 *   78  7508  fabric-relay.test.mjs      engine (WS /api/fabric/relay)
 *   79  7509  fabric-relay.test.mjs      DEAD broker port
 *   80  7510  fabric-relay.test.mjs      stub fabric (/checkin /ack WS
 *             /subscribe; stands in for :8204)
 *   81  7511  fabric-seen.test.ts        stub fabric (/ack WS /subscribe;
 *             in-process subscriber, no engine)
 *
 *   82  7512  room-held.probe.mjs        engine (room front end, item 7)
 *   83  7513  room-held.probe.mjs        DEAD broker port
 *   84  7514  vscreen-engine.test.mjs    engine (booted twice on one table:
 *             spawn, then a restart that adopts)
 *   85  7515  vscreen-engine.test.mjs    LIVE scratch broker (outlives the
 *             first engine, as the real one does)
 *   86  7516  assemble-engine.probe.mjs  engine (Assemble room S1 on real S0)
 *   87  7517  assemble-engine.probe.mjs  DEAD broker port
 *   88  7518  assemble-modal.probe.mjs   engine (Assemble room S1, stubbed design)
 *   89  7519  assemble-modal.probe.mjs   DEAD broker port
 *   94  7524  assemble.test.mjs          engine (assemble room S0: readiness,
 *             assemble, /health flags)
 *   95  7525  assemble.test.mjs          DEAD broker port
 *   96  7526  mcp-indicator.probe.mjs    engine (MCP-call indicator renderer)
 *   97  7527  mcp-indicator.probe.mjs    DEAD broker port
 *   98  7528  mcp-indicator.test.mjs     engine (pane.mcp from the hook sink;
 *             96/97 are cli-manager's mcp-indicator probe, rooms branch)
 *   99  7529  mcp-indicator.test.mjs     LIVE scratch broker
 *  100  7530  room-panels.test.mjs       engine (room panels [ticket])
 *  101  7531  room-panels.test.mjs       DEAD broker port
 *  102  7532  room-panels.test.mjs       stub panel app (the proxy's upstream)
 *  103  7533  room-panels.test.mjs       DEAD panel upstream (nothing may listen)
 *  104  7534  room-assets.test.mjs       engine (room assets [ticket])
 *  105  7535  room-assets.test.mjs       DEAD broker port
 *  106  7536  room-assets.test.mjs       stub agent-share (stands in for :8215)
 *  110  7540  room-round3.probe.mjs      engine (room round 3: preview column, settings)
 *  111  7541  room-round3.probe.mjs      DEAD broker port
 *  112  7542  room-cycle.test.mjs        stub fabric (/checkin /send /threads
 *             /presence WS /subscribe; stands in for :8204) — the reconnect
 *             notice. Its engine + LIVE broker are 92/93.
 *  114  7544  room-authorship.probe.mjs  engine (room authorship v2)
 *  115  7545  room-authorship.probe.mjs  DEAD broker port
 *  116  7546  room-drafts.probe.mjs      engine (room drafts + Ctrl+Enter caret)
 *  117  7547  room-drafts.probe.mjs      DEAD broker port
 *  118  7548  room-mentions.probe.mjs    engine (@names coloured in the line; your @name)
 *  119  7549  room-mentions.probe.mjs    DEAD broker port
 *  120  7550  pane-tokens-engine.test.mjs engine (briefing-table-mcp S1; booted
 *             four times on one table: flag off, then legacy/both/strict)
 *  121  7551  pane-tokens-engine.test.mjs LIVE scratch broker (outlives every
 *             engine, so each restart ADOPTS the panes)
 *  122  7552  project-routes.test.mjs    engine (project channel: activity + locks)
 *  123  7553  project-routes.test.mjs    DEAD broker port
 *  124  7554  project-hooks.test.mjs     stub engine (serves /api/projects/:slug/activity)
 *  125  7555  project-hooks.test.mjs     DEAD engine port (nothing may listen: the
 *             hook's silence when the engine is down)
 *  126  7556  room-voice-e1b.test.ts     engine (room voice E1b, identity both;
 *             booted twice on one table: the restart case)
 *  127  7557  room-voice-e1b.test.ts     DEAD broker port
 *  128  7558  room-voice-e1b.test.ts     stub the voice service for the engine (/state, /characters)
 *  129  7559  room-voice-e1b.test.ts     stub the voice service for the in-process half
 *  130  7560  room-voice-e1c.test.ts     engine (via scripts/room-voice-fixture.mjs)
 *  131  7561  room-voice-e1c.test.ts     LIVE scratch broker (the fixture's seat pane)
 *  132  7562  room-voice-e1c.test.ts     stub the voice service (the fixture's)
 *  133  7563  room-voice-e1c.test.ts     stub the voice service for the in-process half
 *  134  7564  room-voice-e1c.test.ts     DEAD the voice service port (the unreachable case; nothing may listen)
 *  140  7570  room-attach.test.mjs       engine (room composer attachments [ticket])
 *  141  7571  room-attach.test.mjs       DEAD broker port
 *  142  7572  room-attach.test.mjs       stub agent-share (stands in for :8215)
 *  143  7573  room-attach.test.mjs       DEAD room-assets app (stands in for :8206;
 *             nothing may listen — the suite only registers the panel)
 *  144  7574  room-attach.probe.mjs      engine (the composer's + / tray / sent line)
 *  145  7575  room-attach.probe.mjs      DEAD broker port
 *  146  7576  room-attach.probe.mjs      stub agent-share (stands in for :8215)
 *  147  7577  room-attach.probe.mjs      stub room-assets app (stands in for :8206)
 *  150  7580  room-seat-menu.probe.mjs   engine (the seat context menu)
 *  151  7581  room-seat-menu.probe.mjs   DEAD broker port
 *  152  7582  room-voice.probe.mjs       engine (room voice W1: the page's half, shapes stubbed)
 *  153  7583  room-voice.probe.mjs       DEAD broker port
 *  160  7590  room-filter.probe.mjs      engine (the line filter as one button)
 *  161  7591  room-filter.probe.mjs      DEAD broker port
 *  162  7592  room-rail.probe.mjs        engine (the resizable left column)
 *  163  7593  room-rail.probe.mjs        DEAD broker port
 *  164  7594  room-add-sheet.probe.mjs   engine (the room + sheet, the panel menu)
 *  165  7595  room-add-sheet.probe.mjs   DEAD broker port
 *  166  7596  room-add-sheet.probe.mjs   stub panel host (plain panels; the fake tool apps are own-process, ephemeral ports)
 *  170  7600  room-apps.test.mjs         engine (room apps [rooms/apps-engine], tool registry + membership)
 *  171  7601  room-apps.test.mjs         DEAD broker port
 *  172  7602  room-apps.test.mjs         fake tool app (health/render/bind — stands in for a tool's own port)
 *  173  7603  room-apps.test.mjs         second fake tool app (exclusive-conflict / move cases)
 *  180  7610  room-reply.test.ts         stub fabric (/presence /threads /send;
 *             in-process rooms routes, no engine)
 *  181  7611  room-reply.probe.mjs       engine (reply to a line + the seat badge)
 *  182  7612  room-reply.probe.mjs       DEAD broker port
 *  183  7613  room-held-push.probe.mjs   engine (the seat row moves with the held queue)
 *  184  7614  room-held-push.probe.mjs   LIVE scratch broker (a real bash pane)
 *  185-189    RESERVED for the reply work (rooms/reply)
 *  190  7620  recipe-effort-routes.test.mjs engine (recipe effort + per-launch
 *             model/effort overrides + seat start resume [rooms/effort])
 *  191  7621  recipe-effort-routes.test.mjs DEAD broker port
 *  192  7622  recipe-form.probe.mjs      engine (the recipe form: Effort beside
 *             Model, no Resume checkbox, the legacy named-resume line)
 *  193  7623  recipe-form.probe.mjs      DEAD broker port
 *  194-195    RESERVED for rooms/effort
 *  196  7626  room-close-window.test.mjs engine (seat menu Close window route)
 *  197  7627  room-close-window.test.mjs LIVE scratch broker
 *  198  7628  room-close-window.probe.mjs engine (room page + solo pages)
 *  199  7629  room-close-window.probe.mjs LIVE scratch broker
 *  200  7630  room-to-me.probe.mjs       engine (the line's "To me": @user / @owner / replies)
 *  201  7631  room-to-me.probe.mjs       DEAD broker port
 *  202-203    RESERVED for rooms/to-me
 *  204  7634  room-character.probe.mjs   engine (room character: art, wash, accent [rooms/character])
 *  205  7635  room-character.probe.mjs   DEAD broker port
 *  206-209    RESERVED for rooms/character
 *  210  7640  room-links.probe.mjs       engine (links in room lines + the reply prefill)
 *  211  7641  room-links.probe.mjs       DEAD broker port
 *  212-213    RESERVED for rooms/links
 *  214  7644  room-bubbles.probe.mjs     engine (bubble transparency / blur / wash [rooms/bubbles])
 *  215  7645  room-bubbles.probe.mjs     DEAD broker port
 *  216-217    RESERVED for rooms/bubbles
 *  218  7648  room-tool-links.test.ts    stub fabric (stands in for :8204)
 *  219  7649  room-tool-links.probe.mjs  engine (line links into a tool view [rooms/tool-links])
 *  220  7650  room-tool-links.probe.mjs  DEAD broker port
 *  221  7651  room-tool-links.probe.mjs  fake app (links + @meta + compose)
 *  222-223    RESERVED for rooms/tool-links
 *  224  7654  settings-page.probe.mjs    engine (the global Settings page + its mount contract [web/settings-page])
 *  225  7655  settings-page.probe.mjs    DEAD broker port
 *  226-227    RESERVED for web/settings-page
 *  228-229    RETIRED (room-bubble-fade.probe, removed 2026-09-29; do not reuse)
 *  230-231    RESERVED for rooms/bubble-desat
 *  232  7662  room-ios.probe.mjs         engine (the room page locked to the glass on iPhone [web/room-ios-lock])
 *  233  7663  room-ios.probe.mjs         DEAD broker port
 *  234-235    RESERVED for web/room-ios-lock
 *  236  7666  room-image-links.probe.mjs engine (image links in lines as thumbnails [web/image-links])
 *  237  7667  room-image-links.probe.mjs DEAD broker port
 *  238  7668  room-image-links.probe.mjs stub agent-share (stands in for :8215)
 *  239        RESERVED for web/image-links
 *  240  7670  room-phone-7.probe.mjs     engine (seven phone room changes [web/room-phone-7])
 *  241  7671  room-phone-7.probe.mjs     DEAD broker port
 *  242-243    RESERVED for web/room-phone-7
 *  244  7674  solo-keybar.probe.mjs      engine (the solo key bar follows the soft keyboard [web/solo-keybar-auto]);
 *                                        touch-scroll.probe.mjs rides it when the keybar probe runs it
 *  245  7675  solo-keybar.probe.mjs      LIVE scratch broker
 *  246-247    RESERVED for web/solo-keybar-auto
 *  248  7678  traffic.probe.mjs          engine (poll traffic per endpoint [perf/poll-traffic])
 *  249  7679  traffic.probe.mjs          DEAD broker port
 *  250  7680  poll-traffic.test.mjs      engine (the polled routes' wire shape [perf/poll-traffic])
 *  251  7681  poll-traffic.test.mjs      DEAD broker port
 *  252  7682  room-panel-actions.test.mjs  engine (panel actions [ticket])
 *  253  7683  room-panel-actions.test.mjs  DEAD broker port
 *  254  7684  room-panel-actions.probe.mjs engine (panel actions, the room page)
 *  255  7685  room-panel-actions.probe.mjs DEAD broker port
 *  256  7686  project-notify-hooks.test.mjs  stub engine (POST /api/projects/:slug/shared-commit)
 *  257  7687  project-notify-hooks.test.mjs  DEAD port (the "engine down" case: nothing listens)
 *  258  7688  room-char-limit.probe.mjs  engine (composer char-limit warning [ticket])
 *  259  7689  room-char-limit.probe.mjs  DEAD broker port
 *  272  7702  workers-engine.test.mjs    engine (group-jobs worker port [ticket])
 *  273  7703  workers-engine.test.mjs    LIVE scratch broker (both worker links, `homebase` + `gemini`)
 *  274-279    RESERVED for engine/workers
 *  280  7710  room-apps-settings.test.mjs  engine (Settings → Apps routes, app status, room notices [ticket])
 *  281  7711  room-apps-settings.test.mjs  DEAD broker port
 *  282  7712  settings-apps.probe.mjs     engine (Settings → Apps, + sheet sections, rail badge, app-status port [ticket])
 *  283  7713  settings-apps.probe.mjs     DEAD broker port
 *  284  7714  room-panel-posts.test.mjs  engine (panel actions post to the room [ticket])
 *  285  7715  room-panel-posts.test.mjs  DEAD broker port
 *  286  7716  room-panel-posts.probe.mjs engine (the via-app line + the approval diff [ticket])
 *  287  7717  room-panel-posts.probe.mjs DEAD broker port
 *  288-289    RESERVED for web/apps-settings
 *  290  7720  room-needs-you.probe.mjs   engine (a seat that needs you: login/permission/question [ticket])
 *  291  7721  room-needs-you.probe.mjs   LIVE scratch broker (a real bash pane filed as gemini-cli)
 *  292-299    RESERVED for feat/blocked-on-prompt
 *  300  7730  room-app-dialog.probe.mjs  engine (an app opens a dialog from a click [ticket])
 *  301  7731  room-app-dialog.probe.mjs  DEAD broker port
 *  302-303    RESERVED for feat/app-dialog
 *  304  7734  fabric-restore.test.mjs   engine (POST /api/fabric/restore + held-mail preambles [ticket];
 *             booted twice on one table: the restart-with-adoption case)
 *  305  7735  fabric-restore.test.mjs   LIVE scratch broker (stub `claude` panes; outlives the first engine)
 *  306  7736  fabric-restore.test.mjs   stub fabric (/ack, WS /subscribe with a mailbox; stands in for :8204)
 *  307        RESERVED for feat/fabric-restore
 *  312  7742  room-panel-posts.test.mjs  stub fabric (/threads + /send recorded: a via-app line's channel copy [ticket])
 *  313-315    RESERVED for feat/posts-to-requester
 *  316  7746  seat-reload.test.mjs      engine (seat menu "Reload from project
 *             defaults" [ticket])
 *  317  7747  seat-reload.test.mjs      LIVE scratch broker (stub `claude` panes)
 *  318  7748  seat-reload.test.mjs      stub fabric (/checkin /send /threads
 *             /presence WS /subscribe; stands in for :8204)
 *  319  7749  room-seat-menu-reload.probe.mjs  engine (the seat menu's
 *             "Reload from project defaults…" dialog [ticket])
 *  320  7750  room-seat-menu-reload.probe.mjs  DEAD broker port
 *  321-323    RESERVED for feat/seat-reload
 *  324  7754  room-notes-e2e.probe.mjs   engine (notes: the room page against a real engine)
 *  325  7755  room-notes-e2e.probe.mjs   DEAD broker port
 *  326  7756  room-notes-e2e.probe.mjs   the room-assets panel app (only when ROOM_ASSETS_DIR is set)
 *  361  7791  library-proxy.test.mjs     engine (the asset picker's library proxy)
 *  362  7792  library-proxy.test.mjs     DEAD broker port
 *  363  7793  library-proxy.test.mjs     stub asset-library gateway (stands in for :8260)
 *  364  7794  asset-picker.probe.mjs     engine (the picker in the room page, mock only)
 *  365  7795  asset-picker.probe.mjs     DEAD broker port
 *  366  7796  asset-picker.probe.mjs     stub asset-library gateway
 *  380  7810  agent-chat-routes.test.mjs   engine (agent chat routes [agent chat])
 *  381  7811  agent-chat-routes.test.mjs   DEAD broker port
 *  382  7812  agent-chat-routes.test.mjs   stub agent-share (stands in for :8215)
 *  390  7820  room-live-preview.probe.mjs  engine (phone Room settings Live preview, mock only)
 *  391  7821  room-live-preview.probe.mjs  DEAD broker port
 *  424  7854  room-pv-width.probe.mjs   engine (the preview column's width, the drawer and the Assets grid, mock only)
 *  425  7855  room-pv-width.probe.mjs   DEAD broker port
 *  422  7852  room-layers.probe.mjs   engine (one name per level, the phone's one menu, an agent page's menu, mock only)
 *  423  7853  room-layers.probe.mjs   DEAD broker port
 *  433  7863  live-heading.probe.mjs   engine (the Workbench's Live sessions heading: counts + Show all, /api/table and /api/rooms stubbed)
 *  434  7864  live-heading.probe.mjs   DEAD broker port
 *  437  7867  line-markdown.probe.mjs   engine (Markdown in a chat bubble: the real renderer, a message with every element)
 *  438  7868  line-markdown.probe.mjs   DEAD broker port
 *  435  7865  basic-real.probe.mjs   engine (HARBOR_WB_EDITION=basic: the REAL Basic engine behind the Basic screens; fake `site` command)
 *  436  7866  basic-real.probe.mjs   DEAD broker port
 *  428  7858  scratch-real.probe.mjs   engine (the REAL Scratchpad batch: counts, seen, thumbs, item verbs; stub share below)
 *  429  7859  scratch-real.probe.mjs   DEAD broker port
 *  430  7860  scratch-real.probe.mjs   stub agent-share (stands in for :8215: list, upload, move, raw)
 *  431  7861  room-switch-app.probe.mjs   engine (the right-hand app across a room / workgroup switch, mock only)
 *  432  7862  room-switch-app.probe.mjs   DEAD broker port
 *  426  7856  basic-hide.probe.mjs   engine (Basic edition: what is hidden, /health stubbed, mock only)
 *  427  7857  basic-hide.probe.mjs   DEAD broker port
 *  418  7848  room-scratchpad.probe.mjs   engine (the Scratchpad cell, lists and one-item views, mock only)
 *  419  7849  room-scratchpad.probe.mjs   DEAD broker port
 *  416  7846  wg-follow.probe.mjs   engine (a workgroup's Follow-the-room switch, mock only)
 *  417  7847  wg-follow.probe.mjs   DEAD broker port
 *  414  7844  window-chrome-v35.probe.mjs   engine (the shell's hub tab reads Workbench; .ghost scoped, mock only)
 *  415  7845  window-chrome-v35.probe.mjs   DEAD broker port
 *  410  7840  room-search.probe.mjs   engine (search this room, mock only)
 *  411  7841  room-search.probe.mjs   DEAD broker port
 *  408  7838  agent-chat-scroll.probe.mjs   engine (the agent chat's scrolling rules, mock only)
 *  409  7839  agent-chat-scroll.probe.mjs   DEAD broker port
 *  406  7836  room-reload-progress.probe.mjs   engine (the seat Reload card's progress state, mock only)
 *  407  7837  room-reload-progress.probe.mjs   DEAD broker port
 *  404  7834  room-dialog-kb.probe.mjs   engine (dialogs above the soft keyboard, mock only)
 *  405  7835  room-dialog-kb.probe.mjs   DEAD broker port
 *  402  7832  room-cross-unread.probe.mjs   engine (the cross-family unread alert, mock only)
 *  403  7833  room-cross-unread.probe.mjs   DEAD broker port
 *  400  7830  room-feed-empty.probe.mjs   engine (a feed that hides every loaded line, mock only)
 *  401  7831  room-feed-empty.probe.mjs   DEAD broker port
 *  398  7828  room-ipad-tabs.probe.mjs   engine (the shell's tab strip on a touch tablet, mock only)
 *  399  7829  room-ipad-tabs.probe.mjs   DEAD broker port
 *  560  8290  desktop-shell.probe.mjs   engine (a desktop browser enters the shell, mock only)
 *  561  8291  desktop-shell.probe.mjs   DEAD broker port
 *  394  7824  room-ipad-keys.probe.mjs   engine (the rail Keys block on a touch tablet, mock only)
 *  395  7825  room-ipad-keys.probe.mjs   DEAD broker port
 *  396  7826  room-ipad-kb.probe.mjs   engine (the soft keyboard on a touch tablet, mock only)
 *  397  7827  room-ipad-kb.probe.mjs   DEAD broker port
 *  420  7850  agent-rest.test.ts   fake engine /pty socket (answers attach with pane.ready)
 *  421  7851  hosted-instance.test.mjs   engine (a hosted instance: HARBOR_WB_DATA_DIR)
 *  422  7852  hosted-instance.test.mjs   DEAD broker port
 *  423  7853  scratch-seen.test.ts   stub agent-share (list + upload)
 *  424  7854  scratch-items.test.ts   stub agent-share (list, upload, move, raw)
 *  425  7855  wake-deliver.test.ts   fake engine /pty socket (answers attach with pane.ready)
 *  510  7940  reply-turns-routes.test.mjs   engine, HARBOR_WB_REPLY_TURNS=enforce (cloud-agent job 1)
 *  511  7941  reply-turns-routes.test.mjs   DEAD broker port
 *  512  7942  reply-turns-routes.test.mjs   engine, reply turns off
 *  513  7943  reply-turns-routes.test.mjs   DEAD broker port
 *  514  7944  concierge-routes.test.mjs   engine, HARBOR_WB_PANE_TOKENS=1 (cloud-agent job 2)
 *  515  7945  concierge-routes.test.mjs   DEAD broker port
 *  516  7946  concierge-flyout.probe.mjs   engine (the fly-out in a real browser; not in npm test)
 *  517  7947  concierge-flyout.probe.mjs   DEAD broker port
 *  518-529    RESERVED for the cloud-agent branch (assistant switch)
 *  530  7960  reply-turns-fabric.test.mjs   engine, reply turns enforce + room fabric on (the turn line on the fabric)
 *  531  7961  reply-turns-fabric.test.mjs   DEAD broker port
 *  532  7962  reply-turns-fabric.test.mjs   stub fabric (/threads + /send recorded; stands in for :8204)
 *  533  7963  room-deliver.test.mjs         engine (held lines: the function-key rule, /deliver)
 *  534  7964  room-deliver.test.mjs         LIVE scratch broker (stub `claude` panes)
 *  535  7965  room-held-notice.probe.mjs    engine (the held notice under the person's message, in a real browser)
 *  536  7966  room-held-notice.probe.mjs    LIVE scratch broker (stub `claude` panes)
 *  537  7967  voice-test-page.probe.mjs     engine (the conversation test page, a fake mic from a WAV)
 *  538  7968  voice-test-page.probe.mjs     DEAD broker port
 *  544  7974  term-grants-engine.test.ts    engine (W3b terminal grants + WS /term, identity both)
 *  545  7975  term-grants-engine.test.ts    LIVE scratch broker (bash panes)
 *  549  7979  realm-engine.test.ts          engine (R6a realm sign-in, identity both; booted twice: off, then on)
 *  550  7980  realm-engine.test.ts          DEAD broker port
 *  551  7981  realm-engine.test.ts          fake OIDC issuer (discovery, JWKS, /oidc/auth, /oidc/token)
 *  552  7982  local-mode-engine.test.mjs   dead broker (the engine is told where a broker would be; none is)
 *  553  7983  local-mode-restart.test.mjs  LIVE scratch broker (stub claude panes; outlives the local engines)
 *  554  7984  build-engine-package.test.mjs  the BUILT broker (health check only)
 *  555  7985  local-mode-term.test.mjs     LIVE scratch broker (a stub claude pane for terminal grants)
 *  556  7986  scripts/measure-engine-memory.mjs  LIVE scratch broker (the memory measurement's panes)
 *
 * A DEAD broker port is exactly as load-bearing as a live one: if anything is
 * listening there, the engine adopts whatever sessions it holds. assertFree
 * every port a suite names, not just the ones it binds.
 */
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BASE_PORT = 7430;

/** Never a scratch port, at any offset. */
export const FORBIDDEN_PORTS = Object.freeze([7430, 7420, 8200, 8201, 8204]);

/** n -> the suites that use P(n). Data for assertFree's message; the comment
 *  table above is the human-readable copy. */
export const PORT_TABLE = Object.freeze({
  1: ['engine.test (engine)'],
  2: ['engine.test (fake window host)'],
  3: ['identity-engine.test (engine)', 'window-agent.test (engine)'],
  4: ['passkey-browser.probe (engine)'],
  5: ['fabric-inbound.test (engine)'],
  6: ['fabric-subscriber.test (engine)', 'identity-introspect.test (legacy engine)', 'shell-tabs.probe (engine)'],
  7: ['identity-introspect.test (strict engine)', 'v21-shell.probe (engine)'],
  8: ['v21-ui.probe (engine)'],
  10: ['engine.test (broker)', 'v21-ui.probe (broker)'],
  11: ['engine.test (remote broker)'],
  12: ['fabric-inbound.test (broker)', 'identity-engine.test (dead broker)', 'window-agent.test (dead broker)'],
  13: ['fabric-subscriber.test (broker)', 'passkey-browser.probe (dead broker)', 'shell-tabs.probe (dead broker)', 'v21-shell.probe (dead broker)'],
  14: ['fabric-subscriber.test (stub fabric)', 'identity-introspect.test (legacy dead broker)'],
  15: ['identity-introspect.test (strict dead broker)'],
  16: ['agent-fs.test (engine)'],
  17: ['agent-fs.test (dead broker)'],
  18: ['manager-color/manager-escape probes (hand-started engine; not P())'],
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [20 + i, ['voice.test (reserved 20-29)']])),
  30: ['rooms-routes.test (engine)'],
  31: ['rooms-routes.test (dead broker)'],
  32: ['manager-rooms.probe (engine)'],
  33: ['manager-rooms.probe (dead broker)'],
  35: ['room-voice-e1a.test (engine)'],
  36: ['room-voice-e1a.test (dead broker)'],
  37: ['room-voice-e1a.test (dead the voice service)'],
  40: ['rooms-ws.test (engine)'],
  41: ['rooms-ws.test (dead broker)'],
  42: ['ws-liveness.test (engine)'],
  43: ['ws-liveness.test (broker)'],
  44: ['room-cycle.probe (engine)'],
  45: ['room-cycle.probe (dead broker)'],
  46: ['room-cells.probe (engine)'],
  47: ['room-cells.probe (dead broker)'],
  48: ['manager-card-mark.probe (engine)'],
  49: ['manager-card-mark.probe (dead broker)'],
  50: ['room-roster.probe (engine)'],
  51: ['room-roster.probe (dead broker)'],
  52: ['rooms-reach.probe (engine)'],
  53: ['rooms-reach.probe (dead broker)'],
  54: ['auriga review engine (hand-run by cli-manager)'],
  55: ['auriga review engine (dead broker)'],
  56: ['room-add.probe (engine)'],
  57: ['room-add.probe (dead broker)'],
  58: ['room-nav.probe (engine)'],
  59: ['room-nav.probe (dead broker)'],
  60: ['agent-slug-derive.test (engine)'],
  61: ['agent-slug-derive.test (dead broker)'],
  62: ['room-reads.probe (engine)'],
  63: ['room-reads.probe (dead broker)'],
  64: ['rooms-roster.test (engine)'],
  65: ['rooms-roster.test (dead broker)'],
  66: ['rooms-roster.test (stub fabric)'],
  67: ['room-actions.probe (engine)'],
  68: ['room-actions.probe (dead broker)'],
  69: ['broker-available.test.ts (dead link literal; not P())'],
  70: ['fabric-send.test (main engine)'],
  71: ['fabric-send.test (dead broker, shared)'],
  72: ['fabric-send.test (stub fabric)'],
  73: ['fabric-send.test (disabled-fabric engine)'],
  74: ['fabric-checkin.test (main engine)'],
  75: ['fabric-checkin.test (dead broker, shared)'],
  76: ['fabric-checkin.test (stub fabric)'],
  77: ['fabric-checkin.test (room-fabric-off engine)'],
  78: ['fabric-relay.test (engine)'],
  79: ['fabric-relay.test (dead broker)'],
  80: ['fabric-relay.test (stub fabric)'],
  81: ['fabric-seen.test (stub fabric)'],
  82: ['room-held.probe (engine)'],
  83: ['room-held.probe (dead broker)'],
  84: ['vscreen-engine.test (engine, booted twice)'],
  85: ['vscreen-engine.test (broker)'],
  86: ['assemble-engine.probe (engine)'],
  87: ['assemble-engine.probe (dead broker)'],
  88: ['assemble-modal.probe (engine)'],
  89: ['assemble-modal.probe (dead broker)'],
  90: ['font-late.probe (engine)'],
  91: ['font-late.probe (broker)'],
  92: ['room-cycle.test (engine)'],
  93: ['room-cycle.test (broker)'],
  94: ['assemble.test (engine)'],
  95: ['assemble.test (dead broker)'],
  96: ['mcp-indicator.probe (engine)'],
  97: ['mcp-indicator.probe (dead broker)'],
  98: ['mcp-indicator.test (engine)'],
  99: ['mcp-indicator.test (broker)'],
  100: ['room-panels.test (engine)'],
  101: ['room-panels.test (dead broker)'],
  102: ['room-panels.test (stub panel app)'],
  103: ['room-panels.test (dead panel upstream)'],
  104: ['room-assets.test (engine)'],
  105: ['room-assets.test (dead broker)'],
  106: ['room-assets.test (stub agent-share)'],
  110: ['room-round3.probe (engine)'],
  111: ['room-round3.probe (dead broker)'],
  112: ['room-cycle.test (stub fabric)'],
  114: ['room-authorship.probe (engine)'],
  115: ['room-authorship.probe (dead broker)'],
  116: ['room-drafts.probe (engine)'],
  117: ['room-drafts.probe (dead broker)'],
  118: ['room-mentions.probe (engine)'],
  119: ['room-mentions.probe (dead broker)'],
  120: ['pane-tokens-engine.test (engine)'],
  121: ['pane-tokens-engine.test (broker)'],
  122: ['project-routes.test (engine)'],
  123: ['project-routes.test (dead broker)'],
  124: ['project-hooks.test (stub engine)'],
  125: ['project-hooks.test (dead engine port)'],
  126: ['room-new-agent.probe (engine)'],
  127: ['room-new-agent.probe (dead broker)'],
  130: ['room-voice-e1b.test (engine)'],
  131: ['room-voice-e1b.test (dead broker)'],
  132: ['room-voice-e1b.test (stub the voice service, engine)'],
  133: ['room-voice-e1b.test (stub the voice service, in-process)'],
  134: ['room-voice-e1c.test (fixture engine)'],
  135: ['room-voice-e1c.test (fixture broker)'],
  136: ['room-voice-e1c.test (fixture stub the voice service)'],
  137: ['room-voice-e1c.test (stub the voice service)'],
  138: ['room-voice-e1c.test (dead the voice service)'],
  140: ['room-attach.test (engine)'],
  141: ['room-attach.test (dead broker)'],
  142: ['room-attach.test (stub agent-share)'],
  143: ['room-attach.test (dead room-assets app)'],
  144: ['room-attach.probe (engine)'],
  145: ['room-attach.probe (dead broker)'],
  146: ['room-attach.probe (stub agent-share)'],
  147: ['room-attach.probe (stub room-assets app)'],
  150: ['room-seat-menu.probe (engine)'],
  151: ['room-seat-menu.probe (dead broker)'],
  160: ['room-filter.probe (engine)'],
  161: ['room-filter.probe (dead broker)'],
  162: ['room-rail.probe (engine)'],
  163: ['room-rail.probe (dead broker)'],
  164: ['room-add-sheet.probe (engine)'],
  165: ['room-add-sheet.probe (dead broker)'],
  166: ['room-add-sheet.probe (stub panel app)'],
  180: ['room-reply.test (stub fabric)'],
  181: ['room-reply.probe (engine)'],
  182: ['room-reply.probe (dead broker)'],
  183: ['room-held-push.probe (engine)'],
  184: ['room-held-push.probe (broker)'],
  190: ['recipe-effort-routes.test (engine)'],
  191: ['recipe-effort-routes.test (dead broker)'],
  192: ['recipe-form.probe (engine)'],
  193: ['recipe-form.probe (dead broker)'],
  194: ['rooms/effort (reserved)'],
  195: ['rooms/effort (reserved)'],
  196: ['room-close-window.test (engine)'],
  197: ['room-close-window.test (broker)'],
  198: ['room-close-window.probe (engine)'],
  199: ['room-close-window.probe (broker)'],
  394: ['room-ipad-keys.probe (engine)'],
  395: ['room-ipad-keys.probe (dead broker)'],
  396: ['room-ipad-kb.probe (engine)'],
  397: ['room-ipad-kb.probe (dead broker)'],
  398: ['room-ipad-tabs.probe (engine)'],
  399: ['room-ipad-tabs.probe (dead broker)'],
  400: ['room-feed-empty.probe (engine)'],
  401: ['room-feed-empty.probe (dead broker)'],
  402: ['room-cross-unread.probe (engine)'],
  403: ['room-cross-unread.probe (dead broker)'],
  404: ['room-dialog-kb.probe (engine)'],
  405: ['room-dialog-kb.probe (dead broker)'],
  406: ['room-reload-progress.probe (engine)'],
  407: ['room-reload-progress.probe (dead broker)'],
  408: ['agent-chat-scroll.probe (engine)'],
  409: ['agent-chat-scroll.probe (dead broker)'],
  410: ['room-search.probe (engine)'],
  411: ['room-search.probe (dead broker)'],
  390: ['room-live-preview.probe (engine)'],
  391: ['room-live-preview.probe (dead broker)'],
  200: ['room-to-me.probe (engine)'],
  201: ['room-to-me.probe (dead broker)'],
  202: ['rooms/to-me (reserved)'],
  203: ['rooms/to-me (reserved)'],
  204: ['room-character.probe (engine)'],
  205: ['room-character.probe (dead broker)'],
  206: ['rooms/character (reserved)'],
  207: ['rooms/character (reserved)'],
  208: ['rooms/character (reserved)'],
  209: ['rooms/character (reserved)'],
  214: ['room-bubbles.probe (engine)'],
  215: ['room-bubbles.probe (dead broker)'],
  216: ['rooms/bubbles (reserved)'],
  217: ['rooms/bubbles (reserved)'],
  218: ['room-tool-links.test (stub fabric)'],
  219: ['room-tool-links.probe (engine)'],
  220: ['room-tool-links.probe (dead broker)'],
  221: ['room-tool-links.probe (fake app)'],
  222: ['rooms/tool-links (reserved)'],
  223: ['rooms/tool-links (reserved)'],
  224: ['settings-page.probe (engine)'],
  225: ['settings-page.probe (dead broker)'],
  226: ['web/settings-page (reserved)'],
  227: ['web/settings-page (reserved)'],
  228: ['retired: room-bubble-fade.probe'],
  229: ['retired: room-bubble-fade.probe'],
  230: ['rooms/bubble-desat (reserved)'],
  231: ['rooms/bubble-desat (reserved)'],
  232: ['room-ios.probe (engine)'],
  233: ['room-ios.probe (dead broker)'],
  234: ['web/room-ios-lock (reserved)'],
  235: ['web/room-ios-lock (reserved)'],
  236: ['room-image-links.probe (engine)'],
  237: ['room-image-links.probe (dead broker)'],
  238: ['room-image-links.probe (stub agent-share)'],
  239: ['web/image-links (reserved)'],
  240: ['room-phone-7.probe (engine)'],
  241: ['room-phone-7.probe (dead broker)'],
  242: ['web/room-phone-7 (reserved)'],
  243: ['web/room-phone-7 (reserved)'],
  244: ['solo-keybar.probe (engine; touch-scroll.probe rides it)'],
  245: ['solo-keybar.probe (broker)'],
  246: ['web/solo-keybar-auto (reserved)'],
  247: ['web/solo-keybar-auto (reserved)'],
  248: ['traffic.probe (engine)'],
  249: ['traffic.probe (dead broker)'],
  250: ['poll-traffic.test (engine)'],
  251: ['poll-traffic.test (dead broker)'],
  252: ['room-panel-actions.test (engine)'],
  253: ['room-panel-actions.test (dead broker)'],
  254: ['room-panel-actions.probe (engine)'],
  255: ['room-panel-actions.probe (dead broker)'],
  256: ['project-notify-hooks.test (stub engine)'],
  257: ['project-notify-hooks.test (dead port)'],
  258: ['room-char-limit.probe (engine)'],
  259: ['room-char-limit.probe (dead broker port)'],
  272: ['workers-engine.test (engine)'],
  273: ['workers-engine.test (broker)'],
  274: ['engine/workers (reserved)'],
  275: ['engine/workers (reserved)'],
  276: ['engine/workers (reserved)'],
  277: ['engine/workers (reserved)'],
  278: ['engine/workers (reserved)'],
  279: ['engine/workers (reserved)'],
  280: ['room-apps-settings.test (engine)'],
  281: ['room-apps-settings.test (dead broker)'],
  282: ['settings-apps.probe (engine)'],
  283: ['settings-apps.probe (dead broker)'],
  284: ['room-panel-posts.test (engine)'],
  285: ['room-panel-posts.test (dead broker)'],
  286: ['room-panel-posts.probe (engine)'],
  287: ['room-panel-posts.probe (dead broker)'],
  288: ['web/apps-settings (reserved)'],
  289: ['web/apps-settings (reserved)'],
  290: ['room-needs-you.probe (engine)'],
  291: ['room-needs-you.probe (broker)'],
  292: ['feat/blocked-on-prompt (reserved)'],
  293: ['feat/blocked-on-prompt (reserved)'],
  294: ['feat/blocked-on-prompt (reserved)'],
  295: ['feat/blocked-on-prompt (reserved)'],
  296: ['feat/blocked-on-prompt (reserved)'],
  297: ['feat/blocked-on-prompt (reserved)'],
  298: ['feat/blocked-on-prompt (reserved)'],
  299: ['feat/blocked-on-prompt (reserved)'],
  304: ['fabric-restore.test (engine, booted twice)'],
  305: ['fabric-restore.test (broker)'],
  306: ['fabric-restore.test (stub fabric)'],
  307: ['feat/fabric-restore (reserved)'],
  316: ['seat-reload.test (engine)'],
  317: ['seat-reload.test (broker)'],
  318: ['seat-reload.test (stub fabric)'],
  319: ['room-seat-menu-reload.probe (engine)'],
  320: ['room-seat-menu-reload.probe (dead broker)'],
  321: ['feat/seat-reload (reserved)'],
  322: ['feat/seat-reload (reserved)'],
  323: ['feat/seat-reload (reserved)'],
  324: ['room-notes-e2e.probe (engine)'],
  325: ['room-notes-e2e.probe (dead broker)'],
  326: ['room-notes-e2e.probe (room-assets panel app)'],
  330: ['room-doc-view.test (static web server)', 'room-doc-view.probe (static web server)'],
  345: ['room-preview-return.test (static web server)'],
  361: ['library-proxy.test (engine)'],
  362: ['library-proxy.test (dead broker)'],
  363: ['library-proxy.test (stub asset library)'],
  364: ['asset-picker.probe (engine)'],
  365: ['asset-picker.probe (dead broker)'],
  366: ['asset-picker.probe (stub asset library)'],
  500: ['scripts/basic-scratch-instance.ts (scratch Basic engine)'],
  501: ['scripts/basic-scratch-instance.ts (scratch Basic pty-broker)'],
  510: ['reply-turns-routes.test (engine, enforce)'],
  511: ['reply-turns-routes.test (dead broker)'],
  512: ['reply-turns-routes.test (engine, off)'],
  513: ['reply-turns-routes.test (dead broker, off)'],
  514: ['concierge-routes.test (engine, pane tokens on)'],
  515: ['concierge-routes.test (dead broker)'],
  516: ['concierge-flyout.probe (engine)'],
  517: ['concierge-flyout.probe (dead broker)'],
  530: ['reply-turns-fabric.test (engine, enforce + room fabric)'],
  531: ['reply-turns-fabric.test (dead broker)'],
  532: ['reply-turns-fabric.test (stub fabric)'],
  533: ['room-deliver.test (engine)'],
  534: ['room-deliver.test (LIVE scratch broker)'],
  535: ['room-held-notice.probe (engine)'],
  536: ['room-held-notice.probe (LIVE scratch broker)'],
  540: ['user-presence-routes.test (engine)'],
  541: ['user-presence-routes.test (dead broker)'],
  542: ['user-device-presence.probe (engine)'],
  543: ['user-device-presence.probe (dead broker)'],
  544: ['term-grants-engine.test (engine)'],
  545: ['term-grants-engine.test (LIVE scratch broker)'],
  546: ['scripts/term-dev-engine.mjs (engine, W3b app integration)'],
  547: ['scripts/term-dev-engine.mjs (scratch broker)'],
  548: ['scripts/term-dev-engine.mjs (Serve-like proxy in front of the engine)'],
  549: ['realm-engine.test (engine)'],
  550: ['realm-engine.test (dead broker)'],
  551: ['realm-engine.test (fake OIDC issuer)'],
  552: ['local-mode-engine.test (dead broker)'],
  553: ['local-mode-restart.test (LIVE scratch broker)'],
  554: ['build-engine-package.test (the built broker)'],
  555: ['local-mode-term.test (LIVE scratch broker)'],
  556: ['scripts/measure-engine-memory.mjs (LIVE scratch broker)'],
});

/** WB_TEST_PORT_OFFSET, validated. Read at call time so a test can vary it. */
export function portOffset() {
  const raw = process.env.WB_TEST_PORT_OFFSET;
  const off = Number(raw === undefined || raw === '' ? 0 : raw);
  if (!Number.isInteger(off) || off < 0) {
    throw new Error(`WB_TEST_PORT_OFFSET must be a non-negative integer (got ${JSON.stringify(raw)})`);
  }
  return off;
}

/** The scratch port for slot n at the current offset. Throws rather than ever
 *  answering a live port. */
export function P(n) {
  if (!Number.isInteger(n)) {
    throw new Error(`P(n) takes an integer slot (got ${JSON.stringify(n)})`);
  }
  const off = portOffset();
  const port = BASE_PORT + n + off;
  if (FORBIDDEN_PORTS.includes(port)) {
    throw new Error(
      `P(${n}) at offset ${off} is :${port}, a LIVE port (never a scratch port: ${FORBIDDEN_PORTS.join(', ')}). ` +
        'Pick another slot or another offset.',
    );
  }
  if (port < 1024 || port > 65535) {
    throw new Error(`P(${n}) at offset ${off} is :${port}, outside 1024-65535`);
  }
  return port;
}

/** Bind and release 127.0.0.1:<port>. Resolves with the port when it is free;
 *  rejects naming the port, the suite that asked, and the suites the table
 *  says own that slot. 127.0.0.1 because it is the address every scratch
 *  engine and broker binds and dials. */
export function assertFree(port, requester = 'a test') {
  let n = null; // the slot at the offset in force NOW, when the caller asked
  try {
    n = port - BASE_PORT - portOffset();
  } catch {
    /* a bad offset is reported by P(); here it only loses the owner name */
  }
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', (err) => {
      const owners = n !== null && PORT_TABLE[n] ? PORT_TABLE[n].join(', ') : 'no suite in the port table';
      reject(
        new Error(
          `scratch port :${port} is busy (${err.code}); ${requester} needs it. ` +
            `P(${n}) belongs to: ${owners}. A leaked process from an aborted run, or a concurrent run ` +
            'at the same WB_TEST_PORT_OFFSET? Find it: ' +
            (process.platform === 'win32' ? `netstat -ano | findstr :${port}` : `ss -ltnp | grep :${port}`),
        ),
      );
    });
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      srv.close(() => resolve(port));
    });
  });
}

const SCRUBBED = /^(PTY_BROKER_|HARBOR_WB_)/i;
const IS_PATH = /^path$/i;
/** The one key the path lives under: Windows env names are case-insensitive
 *  and it spells it `Path`; everywhere else it is `PATH`. */
export const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH';

/** The shell a scratch `kind:'local'` target spawns. The pty-broker spawns
 *  the shell by EXACT NAME (node-pty on Windows does not PATH-search or add
 *  .exe — the 2026-07-07 discovery), so a suite that pins '/bin/bash' fails
 *  on Windows as a cascade of unrelated assertions (voice.test 2026-09-22,
 *  ws-liveness 2026-09-23) — every engine-booting suite takes its shell from
 *  here instead of re-deriving it. */
export function scratchShell() {
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
}

/** An env for a spawned child: process.env minus every PTY_BROKER_* and
 *  HARBOR_WB_* key, the path under exactly one key, and the fabric + NATS
 *  switched off. `extra` wins over all of it (a HARBOR_WB_* key in `extra` is
 *  kept; a PATH/Path key in `extra` replaces the path; an undefined or null
 *  value REMOVES the key, because spawn would otherwise pass the string
 *  "undefined"). */
export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!IS_PATH.test(k) && !SCRUBBED.test(k)) {
      env[k] = v;
    }
  }
  let path = process.env.PATH; // case-insensitive lookup on win32
  env.HARBOR_WB_FABRIC_URL = '';
  env.HARBOR_WB_NATS_URL = '';
  /* The pty-broker refuses to start without a token (H7). A scratch broker is loopback-only and short-lived, so the suite opts out
     explicitly; a test that wants the real posture passes PTY_BROKER_TOKEN, and a token always wins over the opt-out. */
  env.PTY_BROKER_ALLOW_NO_AUTH = '1';
  for (const [k, v] of Object.entries(extra)) {
    if (IS_PATH.test(k)) {
      path = v == null ? undefined : String(v);
    } else if (v == null) {
      delete env[k];
    } else {
      env[k] = String(v);
    }
  }
  if (path !== undefined) {
    env[PATH_KEY] = path;
  }
  /* WB_TEST_LOCAL_MODE=1: run the suite's ENGINE (the spawn that sets a port and a token) in local mode, to prove the room rules behave
     identically there (test/local-mode-rules.test.mjs). Each engine gets its own data and files folders. */
  if (process.env.WB_TEST_LOCAL_MODE === '1' && env.HARBOR_WB_PORT && env.HARBOR_WB_TOKEN) {
    const base = localModeTmp();
    const n = ++localModeSeq;
    env.HARBOR_WB_MODE = 'local';
    env.HARBOR_WB_DATA_DIR = join(base, `data-${n}`);
    env.HARBOR_WB_FILES_DIR = join(base, `files-${n}`);
    env.HARBOR_WB_MEMORY_CEILING_MB = '0';
  }
  return env;
}

let localModeSeq = 0;
let localModeBase = null;
function localModeTmp() {
  if (!localModeBase) {
    localModeBase = mkdtempSync(join(tmpdir(), 'wb-localmode-'));
    process.on('exit', () => {
      try {
        rmSync(localModeBase, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
  }
  return localModeBase;
}

/* ---- the user is a person (rooms Q5 closed, [ticket]) -------------------
 * A /api/rooms* mutation with no `from` acts as the USER, and that takes a
 * HUMAN credential: a window cookie and no bearer (rooms.ts authorFor). An
 * agent's bearer with no `from` is 403 field 'from'. Suites that drive rooms
 * as the user log in once like a window does and send those calls on the
 * cookie; every read and every `from` post stays on the agent's bearer. */

/** The window cookie the shared-token browser login issues. */
export async function windowCookie(base, token) {
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(token)}`,
    redirect: 'manual',
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!/wb_auth=/.test(cookie)) {
    throw new Error(`windowCookie: /login issued no wb_auth cookie (status ${r.status})`);
  }
  return cookie;
}

/** True when this request speaks for the USER in a room: a non-GET to
 *  /api/rooms* whose JSON body names no `from`. */
export function roomUserWrite(path, method, json) {
  const from = json && typeof json === 'object' ? json.from : undefined;
  return (method ?? 'GET') !== 'GET' && path.startsWith('/api/rooms') && (from === undefined || from === null);
}
