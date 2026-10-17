// THIS FILE IS FOR: calling the database functions from node tests and the local dev server, shaped like supabase-js .rpc().
// Test and local use only; the Edge Functions use supabase-js. Each call is one psql process, so parallel calls are
// really parallel sessions (what the concurrency tests need). Needs psql on PATH; no npm packages.
import { spawn } from 'node:child_process';

const NAME = /^[a-z_][a-z0-9_]*$/;

// THIS SECTION IS FOR: refusing to touch anything that is not a throwaway database.
export function assertScratchUrl(url) {
  const db = String(url || '').split('?')[0].split('/').pop();
  if (!/scratch|test|control/i.test(db)) throw new Error('refusing a database whose name lacks scratch/test/control: ' + db);
  return url;
}

// THIS SECTION IS FOR: one psql run. SQL goes in on stdin so :'var' interpolation quotes every value safely.
function psql(url, sql, vars) {
  return new Promise((resolve) => {
    const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', url];
    for (const [k, v] of Object.entries(vars || {})) args.push('-v', k + '=' + v);
    const p = spawn('psql', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    p.stdin.end(sql);
  });
}

// url: a postgres URL whose database name says scratch/test/control. Returns rpc(name, args) -> { data, error }.
export function psqlRpc(url) {
  assertScratchUrl(url);
  const shapes = new Map(); // function name -> 'set' | 'void' | 'value'

  async function shapeOf(name) {
    if (shapes.has(name)) return shapes.get(name);
    const r = await psql(url, "select case when p.proretset then 'set' when p.prorettype = 'void'::regtype then 'void' else 'value' end " +
      "from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = :'fn' limit 1", { fn: name });
    const shape = r.out || null;
    if (shape) shapes.set(name, shape);
    return shape;
  }

  return async function rpc(name, args = {}) {
    if (!NAME.test(name)) return { data: null, error: { message: 'bad function name' } };
    const shape = await shapeOf(name);
    if (!shape) return { data: null, error: { message: 'unknown function ' + name } };
    const vars = {}, params = [];
    Object.entries(args).forEach(([k, v], i) => {
      if (!NAME.test(k)) throw new Error('bad argument name ' + k);
      if (v === null || v === undefined) { params.push(k + ' => null'); return; }
      vars['v' + i] = typeof v === 'object' ? JSON.stringify(v) : String(v);
      params.push(k + " => :'v" + i + "'");
    });
    const callSql = 'public.' + name + '(' + params.join(', ') + ')';
    // jsonb prints on one line (json_agg breaks lines between rows), so the last output line is the whole answer.
    const sql = shape === 'set' ? "select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from " + callSql + ' r'
      : shape === 'void' ? 'select ' + callSql + "; select 'null'"
      : 'select to_jsonb(' + callSql + ')';
    const r = await psql(url, sql, vars);
    if (r.code !== 0) {
      const m = /ERROR:\s+(.*)/.exec(r.err);
      return { data: null, error: { message: m ? m[1] : r.err || 'psql failed' } };
    }
    const last = r.out.split('\n').pop();
    return { data: last === '' ? null : JSON.parse(last), error: null };
  };
}
