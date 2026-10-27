// A recipe as the rail shows it (the design's step-3c page, the rail and broken-recipe tables): the stored
// record resolved against what the renderer knows now, with no DOM in it so the rules are unit-tested.
//
// ctx: { servers: the account's granted rows (accounts:servers), programs: programs:list,
//        sessions: sessions:update rows (recipeId, lastUsed), known: loginIds the account's servers have
//        at all (from the request page's list; a login there without a grant is "No access") }

const W = () => (globalThis.wb && globalThis.wb.web ? 'this server' : 'this computer'); // the web build's words say "server" where the desktop's say "computer"
/** "0.1.1" < "0.2.0": the broker's version against the first that speaks recipes. */
export function olderThan(version, than) {
  const a = String(version).split('.').map((x) => parseInt(x, 10) || 0);
  const b = String(than).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) {
      return (a[i] || 0) < (b[i] || 0);
    }
  }
  return false;
}

/** "Open" / "2 open"; a broken recipe's word and link come from its state. */
export function recipeRows(recipes, ctx) {
  const servers = (ctx && ctx.servers) || [];
  const programs = (ctx && ctx.programs) || [];
  const sessions = (ctx && ctx.sessions) || [];
  const known = new Set((ctx && ctx.known) || []);
  return (recipes || []).map((rc) => {
    // 0.12.1: a recipe on This machine, and "Custom command…", which is not a
    // package: a synthetic program row, labeled in the tooltip by the command itself
    const local = rc.loginId === 'local';
    const row = local ? null : servers.find((r) => r.loginId === rc.loginId && !r.request) || null;
    const program = rc.programId === 'custom' ? { id: 'custom', label: 'Custom command', mark: 'generic', color: null, enabled: true, custom: true } : programs.find((p) => p.id === rc.programId) || null;
    const mine = sessions.filter((s) => s.recipeId === rc.id && (!rc.accountId || s.accountId === rc.accountId));
    const open = mine.length;
    const goSid = open ? mine.slice().sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))[0].sid : null;
    const serverName = local ? W() : row ? row.serverName : rc.where ? rc.where.split(' · ')[0] : 'the server';
    const login = local ? '' : row ? row.login : rc.where ? rc.where.split(' · ')[1] || '' : '';
    const programLabel = program ? (program.custom ? rc.command || 'Custom command' : program.label) : rc.programLabel || rc.programId;
    const v = {
      id: rc.id,
      accountId: rc.accountId || null,
      realmName: row?.realmName || null,
      accountLabel: row?.accountLabel || null,
      name: rc.name,
      logo: rc.logo || null,
      programId: rc.programId,
      loginId: rc.loginId,
      hue: rc.color === 'auto' || rc.color == null ? null : rc.color,
      mark: program ? program.mark : 'generic',
      markColor: program ? program.color : null,
      where: local ? (globalThis.wb && globalThis.wb.web ? 'This server' : 'This machine') : row ? `${row.serverName} · ${row.login}` : rc.where || '',
      tip: local ? `${programLabel} in ${rc.folder} on ${W()}.${W() === 'this server' ? '' : ' Ends when the Workbench closes.'}` : `${programLabel} in ${rc.folder} on ${serverName}${login ? ', as ' + login : ''}`,
      local,
      open,
      goSid,
      state: 'ok',
      word: open ? (open === 1 ? 'Open' : `${open} open`) : '',
      amber: false,
      dim: false,
      line: '', // a second line in place of "server · your account" (the dot + word of a broker that is down or too old)
      dot: null,
      link: '',
      linkAction: null,
      canStart: true,
      startTip: '',
    };
    if(rc.unavailableTarget)return {...v,state:'server-unavailable',where:'Needs a server',canStart:false,word:'',line:'Needs a server',tip:'Needs a server connection, which this version does not have.',startTip:'Needs a server connection, which this version does not have.',blockedStartMessage:`${rc.name} needs a server connection, which this version does not have, so it can't start.`,dim:true};
    if (local) {
      // This machine: no Keeps running, the words of the local report; never a server state
      if (!program) {
        return { ...v, state: 'program-missing', dim: true, dot: 'bad', line: 'Program missing', link: 'Fix…', linkAction: 'fix', canStart: false, startTip: `This recipe uses ${programLabel}, which isn't on this computer. Choose another program.` };
      }
      if (program.enabled === false) {
        return { ...v, state: 'program-off', dim: true, dot: 'bad', line: `${program.label} is off`, link: 'Turn on', linkAction: 'turn-on', canStart: false, startTip: `${program.label} is off. Turn it on in Programs.` };
      }
      if (!program.custom && program.detected && program.detected.state === 'missing') {
        return { ...v, state: 'not-found', line: 'Not found on ' + W(), dot: 'warn' };
      }
      return v;
    }
    if (!row) {
      // the server · login is not among the account's grants: no access (the server is still on the
      // account, ask again) or server missing (gone from the account altogether)
      // every broken state takes page b1's layout: the name dims, the second line is the word (and its
      // link), the right slot stays for Open / 2 open; an error dot where only an edit fixes it, amber
      // where it fixes itself
      if (known.has(rc.loginId)) {
        return { ...v, state: 'no-access', dim: true, dot: 'bad', line: 'No access', link: 'Request access…', linkAction: 'request', canStart: false, startTip: `You no longer have access to ${serverName}${login ? ' · ' + login : ''}.`, tip: `You no longer have access to ${serverName}${login ? ' · ' + login : ''}.` };
      }
      return { ...v, state: 'server-missing', dim: true, dot: 'bad', line: 'Server missing', link: 'Fix…', linkAction: 'fix', canStart: false, startTip: `${serverName} is no longer on your account. Choose where it runs now.` };
    }
    if (!program) {
      return { ...v, state: 'program-missing', dim: true, dot: 'bad', line: 'Program missing', link: 'Fix…', linkAction: 'fix', canStart: false, startTip: `This recipe uses ${programLabel}, which isn't on this computer. Choose another program.` };
    }
    if (program.enabled === false) {
      // "<program> is off · Turn on": its own state, distinct from Program missing (ruled )
      return { ...v, state: 'program-off', dim: true, dot: 'bad', line: `${program.label} is off`, link: 'Turn on', linkAction: 'turn-on', canStart: false, startTip: `${program.label} is off. Turn it on in Programs.` };
    }
    if (row.brokerVersion && olderThan(row.brokerVersion, '0.2.0')) {
      // the realm reports the broker's version: a broker before 0.2.0 can't start recipes;
      // the row says so up front, amber, Start off with the card's first line
      // page b1: the name dims and the second line becomes the amber dot + the word; the right slot keeps Open / 2 open
      return { ...v, state: 'broker-old', dim: true, line: 'Broker too old', dot: 'warn', canStart: false, startTip: `${row.serverName}'s broker for ${row.login} is too old for recipes.` };
    }
    if (ctx && ctx.draining && ctx.draining.has(row.id)) {
      // step 3d (the design's 3d page): the broker is waiting to update; Start is off with the card's first line
      return { ...v, state: 'draining', line: 'Waiting to update', dot: 'warn', amber: true, canStart: false, startTip: `${row.serverName} · ${row.login} isn't starting new CLIs right now.` };
    }
    if (row.state === 'broker-down' || row.state === 'identity') {
      // a recipe never falls back to plain ssh: Start is off with the tooltip (ruled )
      return { ...v, state: 'broker-down', dim: true, line: 'Broker not running', dot: 'warn', canStart: false, startTip: `Can't start: ${row.serverName}'s broker for ${row.login} isn't running.` };
    }
    if (row.recipes && row.recipes.allowed === false) {
      // step 3e: the server's recipe policy doesn't let you; the row stays visible with the
      // reason and a lock, and choosing it opens the same card the broker's refusal does
      return { ...v, state: 'recipe-policy', dim: true, lock: true, line: `Not allowed on ${row.serverName}`, startTip: `${row.serverName} doesn't let you start recipes.` };
    }
    const rep = (row.programs || []).find((p) => p.id === rc.programId);
    if (rep && rep.state === 'missing') {
      // the picker never blocks choosing; the row says what the report says, and a launch proves itself
      return { ...v, state: 'not-found', line: `Not found on ${row.serverName}`, dot: 'warn' };
    }
    return v;
  });
}
