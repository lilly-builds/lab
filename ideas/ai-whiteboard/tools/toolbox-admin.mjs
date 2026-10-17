// THIS FILE IS FOR: Lilly's admin door from the terminal (build plan 1.8): create a tester, grant more credit, revoke, unpause, list and
// resolve flags, settle a flagged hold. It calls the deployed admin function; the admin secret comes from AI_ADMIN_SECRET only.
// Usage (from the repo root):
//   AI_ADMIN_SECRET=... node ideas/ai-whiteboard/tools/toolbox-admin.mjs create --label "Sam" --grant 5
//   ... grant --person <id> --amount 3            (prints the retry key; re-run with --idem <key> if the call may not have landed)
//   ... revoke --person <id>    ... unpause --person <id>    ... flags    ... resolve --id <n>
//   ... settle-hold --request <hold id> --cost 0.04     (cost 0 releases it)
// --url points somewhere else (the local dev server: --url http://localhost:8787). Default: the project in supabase-config.js.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// THIS SECTION IS FOR: turning the command line into one admin request. Pure, so a test can check it.
export function requestFor(argv, today = new Date().toISOString().slice(0, 10)) {
  const [cmd, ...rest] = argv;
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) if (rest[i] && rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[i + 1];
  const num = (k) => (opt[k] === undefined ? undefined : Number(opt[k]));
  switch (cmd) {
    case 'create': return { action: 'create', label: opt.label || '', grant: num('grant') };
    case 'grant': return { action: 'grant', person: opt.person, amount: num('amount'), note: opt.note || 'hand grant', idem: opt.idem || today + '-' + randomBytes(4).toString('hex') };
    case 'revoke': return { action: 'revoke', person: opt.person };
    case 'unpause': return { action: 'unpause', person: opt.person };
    case 'flags': return { action: 'flags' };
    case 'resolve': return { action: 'resolve_flag', id: num('id') };
    case 'settle-hold': return { action: 'settle_hold', request: opt.request, cost: num('cost') };
    default: return null;
  }
}

function projectUrl() {
  const cfg = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase-config.js'), 'utf8');
  const m = /url:\s*'([^']+)'/.exec(cfg);
  return m ? m[1] : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const ui = args.indexOf('--url');
  const base = ui >= 0 ? args.splice(ui, 2)[1] : projectUrl();
  const body = requestFor(args);
  const secret = process.env.AI_ADMIN_SECRET;
  if (!body) { console.log('commands: create, grant, revoke, unpause, flags, resolve, settle-hold (see the top of this file)'); process.exit(1); }
  if (!secret) { console.log('set AI_ADMIN_SECRET first (it is never read from the command line)'); process.exit(1); }
  if (body.action === 'grant') console.log('retry key: ' + body.idem + '  (re-run with --idem ' + body.idem + ' if unsure it landed)');
  const res = await fetch(base.replace(/\/+$/, '') + '/functions/v1/admin', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({ ok: false, reason: 'unreadable reply (' + res.status + ')' }));
  if (out.pass) console.log('tester pass, shown once (send it privately; it is not stored anywhere): ' + out.pass);
  delete out.pass;
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
