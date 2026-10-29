#!/usr/bin/env node
/**
 * arachne — terminal client.
 *
 * The GUI is where the room lives; this is where it fits in a pipeline.
 * Everything is the same HTTP/SSE API the browser uses, so nothing here can
 * drift from the web app.
 */
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The CLI is a client; `serve` just starts the room runtime if it is around. */
function findServer() {
  const candidates = [
    process.env.ARACHNE_HOME && path.join(process.env.ARACHNE_HOME, 'server', 'index.mjs'),
    path.join(ROOT, '..', 'gui', 'server', 'index.mjs'),
    path.join(ROOT, 'server', 'index.mjs'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// ---------------------------------------------------------------- flags

const argv = process.argv.slice(2);
const flags = new Map();
const words = [];
// only these take a value; the rest are booleans, so `--json status` still parses
const VALUE_FLAGS = new Set(['url', 'port', 'agent', 'members', 'targets', 'client', 'thread', 'skills']);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, inline] = a.slice(2).split('=');
    if (inline !== undefined) flags.set(k, inline);
    else if (VALUE_FLAGS.has(k) && argv[i + 1] && !argv[i + 1].startsWith('-')) { flags.set(k, argv[i + 1]); i += 1; }
    else flags.set(k, true);
  } else words.push(a);
}

const BASE = String(flags.get('url') || process.env.ARACHNE_URL || 'http://127.0.0.1:7777').replace(/\/+$/, '');
const JSON_OUT = Boolean(flags.get('json'));
const NO_COLOR = Boolean(flags.get('no-color')) || Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;

const paint = (code) => (s) => (NO_COLOR ? String(s) : `\x1b[${code}m${s}\x1b[0m`);
const dim = paint('2');
const bold = paint('1');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const blue = paint('34');
const magenta = paint('35');
const cyan = paint('36');
const thex = (hex) => {
  if (NO_COLOR || !/^#[0-9a-f]{6}$/i.test(hex || '')) return (s) => String(s);
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
  return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
};

const SEV = { critical: red, high: yellow, medium: cyan, low: blue, info: dim };
const STATUS = { confirmed: green, reproduced: yellow, candidate: dim, dismissed: dim };

// ---------------------------------------------------------------- http

class Unreachable extends Error {}

async function call(method, pathname, body) {
  let res;
  try {
    res = await fetch(BASE + pathname, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Unreachable(`cannot reach ${BASE} — start it with "arachne serve"\n${err.message}`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new Error(json?.error || `${res.status} ${res.statusText}`);
  return json;
}

async function* stream(pathname, body, signal) {
  let res;
  try {
    res = await fetch(BASE + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    throw new Unreachable(`cannot reach ${BASE} — start it with "arachne serve"\n${err.message}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { yield JSON.parse(line.slice(5).trim()); } catch { /* partial */ }
      }
    }
  }
}

// ---------------------------------------------------------------- render

const agentsById = new Map();

async function loadRoster() {
  const { agents } = await call('GET', '/api/roster');
  for (const a of agents) agentsById.set(a.id, a);
  return agents;
}

const agentOf = (id) => agentsById.get(id) || { id, name: id, role: '', color: '' };
const agentPaint = (id) => thex(agentOf(id).color);

const fmtArgs = (args) => {
  if (!args) return '';
  const parts = Object.entries(args)
    .filter(([, v]) => v !== '' && v != null)
    .slice(0, 3)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${s.length > 42 ? `${s.slice(0, 40)}…` : s}`;
    });
  return parts.join(' ');
};

class Render {
  constructor() {
    this.open = false;       // inside an agent block?
    this.agent = null;
    this.sawText = false;
    this.pending = new Map();
  }

  line(s = '') {
    process.stdout.write(`${s}\n`);
  }

  ev(ev) {
    if (JSON_OUT) {
      this.line(JSON.stringify(ev));
      return;
    }
    const color = agentPaint(ev.agentId);
    switch (ev.type) {
      case 'thread':
        this.threadId = ev.threadId;
        break;
      case 'agent_start': {
        this.line();
        this.open = true;
        this.sawText = false;
        const skills = ev.skills?.length ? dim(`  [${ev.skills.join(', ')}]`) : '';
        this.line(`${color('◍')} ${bold(color(agentOf(ev.agentId).name))} ${dim(agentOf(ev.agentId).role.toLowerCase())} ${dim(`· ${ev.model}`)}${skills}`);
        break;
      }
      case 'token':
        if (!this.sawText) { this.line(); this.sawText = true; }
        process.stdout.write(ev.text);
        break;
      case 'replace':
        // the model printed a tool call in its text; the call was extracted
        this.line(dim(`  (printed tool call extracted)`));
        break;
      case 'tool_call':
        this.line(`${dim('  ⚙')} ${ev.name} ${dim(fmtArgs(ev.args))}`);
        this.pending.set(ev.name, ev.id);
        break;
      case 'tool_result': {
        const first = String(ev.output || '').split('\n')[0].slice(0, 100);
        const mark = ev.ok ? green('✓') : red('✗');
        this.line(dim(`    ${mark} ${ev.ms}ms `) + dim(first));
        break;
      }
      case 'finding': {
        const f = ev.finding;
        const sev = (SEV[f.severity] || dim)(String(f.severity || '').toUpperCase().padEnd(8));
        const st = (STATUS[f.status] || dim)(f.status);
        this.line(`${dim('  ⚑')} ${sev} ${f.cwe || ''} ${f.title} ${dim(`${f.file || ''}:${f.line || 0}`)} ${dim('·')} ${st}`);
        break;
      }
      case 'intent':
        this.line(`${dim('  ◆')} ${dim(ev.intent.id)} ${ev.intent.title}`);
        break;
      case 'tapback':
        this.line(`${dim('  👍')} ${dim(`${agentOf(ev.agentId).name} has nothing to add`)}`);
        break;
      case 'handoff':
        this.line(`${dim('  ↪')} ${dim(`${agentOf(ev.from).name} hands the floor to ${agentOf(ev.to).name}`)}`);
        break;
      case 'phase': {
        const dot = { running: yellow('●'), done: green('●'), error: red('●'), skipped: dim('●') }[ev.status] || dim('●');
        this.line(`  ${dot} ${ev.id.padEnd(8)} ${dim(String(ev.detail || '').slice(0, 64))}`);
        break;
      }
      case 'surface':
        this.line(dim(`    ${ev.surface.fileCount} files · ${ev.surface.loc} LOC · ${ev.surface.languages.map((l) => l.lang).join('/') || '?'} · ${ev.surface.entryPoints.length} entry points`));
        break;
      case 'note':
        this.line(`${yellow('  ·')} ${dim(ev.text)}`);
        break;
      case 'error': {
        this.line();
        const lines = String(ev.message).split('\n').filter(Boolean);
        this.line(`${red('  !')} ${lines[0] || 'error'}`);
        for (const extra of lines.slice(1, 5)) this.line(dim(`    ${extra}`));
        this.open = false;
        break;
      }
      case 'done': {
        if (this.sawText) this.line();
        const tok = ev.usage?.total ? ` · ${(ev.usage.total / 1000).toFixed(1)}k tok` : '';
        const cost = ev.cost ? ` · $${ev.cost.toFixed(4)}` : '';
        this.line(dim(`  ── ${(ev.ms / 1000).toFixed(1)}s · ${ev.steps || 0} steps${tok}${cost}`));
        this.open = false;
        this.sawText = false;
        break;
      }
      case 'hunt_done':
        this.line();
        this.line(`${green('✓')} report ${bold(ev.report)}  ${dim(`${ev.confirmed} confirmed · ${ev.candidates} candidates · ${ev.intents} intent${ev.intents === 1 ? '' : 's'}`)}`);
        break;
      case 'stage_skipped':
        this.line(dim(`  · ${ev.agentId} skipped: ${ev.reason}`));
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------- commands

const help = () => {
  console.log(`
${bold('arachne')} — local agent room for RCE research

${bold('USAGE')}
  arachne <command> [options]

${bold('COMMANDS')}
  serve                     start the server and the web UI
  status                    engines, routing, scope, counts
  agents                    the roster: role, tools, skills, model
  skills                    installed skills
  chat [--agent id]         interactive session
  ask <agent> <text…>       one turn, streamed
  room <text…>              fan out to the room
  hunt <target>             run the seven-stage pipeline
  findings                  findings, newest first
  ledger [--clear]          coverage facts and open intents
  engagement new <name> --targets a,b
  engagement list | use <id>
  tool <name> '<json>'      run one tool by hand

${bold('OPTIONS')}
  --url <url>               default http://127.0.0.1:7777 (or ARACHNE_URL)
  --json                    raw events, one JSON object per line
  --no-color                plain text
  --members a,b,c           room / hunt members
  --port <n>                serve only

${bold('IN A CHAT')}
  /agent <id>   switch agent      /room        fan out to the room
  /hunt <path>  run the pipeline  /skills      list skills
  /ledger       coverage          /findings    findings
  /new          new thread        /help        this list
`);
};

async function cmdServe() {
  const server = findServer();
  if (!server) {
    console.error(`\n${red('no server found')} — run this from beside the arachne-gui checkout,`);
    console.error(`or set ARACHNE_HOME to the folder holding server/index.mjs.\n`);
    process.exitCode = 1;
    return;
  }
  const port = String(flags.get('port') || process.env.PORT || 7777);
  const child = spawn(process.execPath, [server], {
    stdio: 'inherit',
    env: { ...process.env, PORT: port },
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function cmdStatus() {
  const h = await call('GET', '/api/health?refresh=1');
  if (JSON_OUT) { console.log(JSON.stringify(h, null, 2)); return; }
  const live = h.engines.filter((e) => e.ok);
  console.log();
  console.log(`${bold('engines')}  ${live.length ? live.map((e) => `${e.label} (${e.models.length})`).join(', ') : red('none reachable')}`);
  for (const [role, r] of Object.entries(h.roles)) {
    const ok = r.model ? green('●') : red('○');
    console.log(`  ${ok} ${role.padEnd(8)} ${dim(r.label)}`);
  }
  console.log(`${bold('scope')}    ${(h.policy.scopeHosts || []).join(', ') || dim('no hosts')}`);
  console.log(`${bold('shell')}    ${h.policy.shell}${h.policy.allowUnsafe ? red(' (unsafe)') : ''}`);
  console.log(`${bold('state')}    ${h.findings} findings · ${h.ledger.tested} tested · ${h.ledger.openIntents} open intents`);
  if (h.engagement) console.log(`${bold('engage')}   ${green(h.engagement.id)} ${dim(h.engagement.name)}`);
  console.log(`${bold('workdir')}  ${h.workspace}`);
  console.log();
}

async function cmdAgents() {
  const [agents, skills] = await Promise.all([loadRoster(), call('GET', '/api/skills')]);
  if (JSON_OUT) { console.log(JSON.stringify({ agents, skills: skills.skills }, null, 2)); return; }
  let health = null;
  try { health = await call('GET', '/api/health'); } catch { /* optional */ }
  console.log();
  for (const a of agents) {
    const color = thex(a.color);
    const route = health?.roles?.[a.id];
    console.log(`${color('◍')} ${bold(color(a.name))} ${dim(a.role.toLowerCase())}${route?.model ? dim(`  ·  ${route.model}`) : ''}`);
    console.log(dim(`    ${a.tagline}`));
    console.log(dim(`    tools   ${a.tools.length ? a.tools.join(' ') : 'none'}`));
    const applicable = skills.skills.filter((s) => !s.agents.length || s.agents.includes(a.id));
    if (applicable.length) console.log(dim(`    skills  ${applicable.map((s) => s.id).join(' ')}`));
    console.log();
  }
}

async function cmdSkills() {
  const { skills } = await call('GET', '/api/skills');
  console.log();
  for (const s of skills) {
    console.log(`${cyan('▪')} ${bold(s.id)} ${dim(`— ${s.description}`)}`);
    console.log(dim(`   agents: ${s.agents.join(', ') || 'all'}`));
  }
  console.log(dim(`\n${skills.length} skills in ./skills — drop a .md file in to add one\n`));
}

async function cmdFindings() {
  const { findings } = await call('GET', '/api/findings');
  if (JSON_OUT) { console.log(JSON.stringify(findings, null, 2)); return; }
  if (!findings.length) {
    console.log(dim('\nno findings yet\n'));
    return;
  }
  console.log();
  for (const f of findings) {
    const sev = (SEV[f.severity] || dim)(String(f.severity || '').padEnd(8));
    const st = (STATUS[f.status] || dim)((f.status || '').padEnd(9));
    console.log(`${sev} ${st} ${f.cwe || '       '} ${f.title}`);
    console.log(dim(`                    ${f.file || ''}:${f.line || 0}${f.repro ? `  repro: ${String(f.repro).slice(0, 70)}` : ''}`));
  }
  const confirmed = findings.filter((f) => f.status === 'confirmed').length;
  console.log(dim(`\n${findings.length} findings, ${confirmed} confirmed\n`));
}

async function cmdLedger() {
  if (flags.get('clear')) {
    await call('DELETE', '/api/ledger');
    console.log(green('ledger cleared'));
    return;
  }
  const data = await call('GET', '/api/ledger');
  if (JSON_OUT) { console.log(JSON.stringify(data, null, 2)); return; }
  const s = data.summary;
  console.log();
  console.log(`${bold('coverage')}  ${s.tested} tested · ${s.observed} observed · ${s.inferred} inferred`);
  const intents = data.intents.filter((i) => i.status !== 'done');
  console.log(`${bold('intents')}   ${intents.length} open`);
  for (const i of intents) console.log(`  ${dim('◆')} ${dim(i.id)} ${i.title}`);
  if (!data.entries.length) console.log(dim('\nno facts recorded yet\n'));
  else {
    console.log();
    for (const e of data.entries.slice(0, 20)) {
      const conf = e.confidence === 'observed' ? green('observed') : yellow('inferred');
      console.log(`${conf} ${e.surface}`);
      console.log(dim(`   ${e.action} → ${String(e.result || '').split('\n')[0].slice(0, 100)}`));
    }
  }
  console.log();
}

async function cmdEngagement() {
  const sub = words[1];
  if (!sub || sub === 'list') {
    const { engagements, active } = await call('GET', '/api/engagements');
    if (!engagements.length) {
      console.log(dim('\nno engagements — arachne engagement new "name" --targets host,dns\n'));
      return;
    }
    console.log();
    for (const e of engagements) {
      const mark = e.active ? green('●') : dim('○');
      console.log(`${mark} ${bold(e.id)} ${e.name} ${dim(e.targets.join(', '))}`);
    }
    console.log();
    return;
  }
  if (sub === 'use') {
    const id = words[2];
    if (!id) throw new Error('usage: arachne engagement use <id>');
    const r = await call('POST', '/api/engagements/activate', { id });
    console.log(`${green('active')} ${r.engagement.id}  ${dim(r.policy.scopeHosts.join(', '))}`);
    return;
  }
  if (sub === 'new') {
    const name = words.slice(2).join(' ').trim();
    const targets = String(flags.get('targets') || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (!name || !targets.length) throw new Error('usage: arachne engagement new "name" --targets host,url');
    const r = await call('POST', '/api/engagements', { name, targets, client: flags.get('client') || '' });
    console.log(`${green('engagement')} ${bold(r.engagement.id)}`);
    console.log(dim(`  ${r.engagement.name} — scoped to ${r.policy.scopeHosts.join(', ')}`));
    console.log(dim(`  artifacts → workspace/${r.engagement.dir}/`));
    return;
  }
  throw new Error(`unknown subcommand: engagement ${sub}`);
}

async function cmdTool() {
  const name = words[1];
  const raw = words[2] || '{}';
  if (!name) throw new Error("usage: arachne tool <name> '<json>'");
  let args;
  try { args = JSON.parse(raw); } catch (err) { throw new Error(`args must be JSON: ${err.message}`); }
  const r = await call('POST', '/api/tool', { name, args });
  console.log(r.output);
}

async function runStream(pathname, body) {
  const r = new Render();
  for await (const ev of stream(pathname, body)) r.ev(ev);
  return r.threadId;
}

async function cmdAsk() {
  const agentId = words[1];
  const text = words.slice(2).join(' ');
  if (!agentId || !text) throw new Error('usage: arachne ask <agent> <text…>');
  await loadRoster();
  await runStream('/api/send', {
    text,
    mode: 'chat',
    agentId,
    threadId: flags.get('thread') || undefined,
    skills: String(flags.get('skills') || '').split(',').filter(Boolean),
  });
}

async function cmdRoom() {
  const text = words.slice(1).join(' ');
  if (!text) throw new Error('usage: arachne room <text…>');
  await loadRoster();
  const members = String(flags.get('members') || 'scout,static,hunter').split(',').map((s) => s.trim()).filter(Boolean);
  await runStream('/api/send', {
    text,
    mode: 'room',
    members,
    skills: String(flags.get('skills') || '').split(',').filter(Boolean),
  });
}

async function cmdHunt() {
  const target = words[1];
  if (!target) throw new Error('usage: arachne hunt <target>');
  await loadRoster();
  await runStream('/api/hunt', { target });
}

// ---------------------------------------------------------------- interactive

async function cmdChat() {
  await loadRoster();
  const skills = (await call('GET', '/api/skills')).skills;
  const state = {
    agent: String(flags.get('agent') || 'chat'),
    mode: 'chat',
    threadId: flags.get('thread') || null,
    skills: new Set(String(flags.get('skills') || '').split(',').filter(Boolean)),
    busy: false,
    abort: null,
  };

  const known = [...agentsById.keys()];
  if (!known.includes(state.agent)) state.agent = 'chat';

  const where = () => {
    const a = agentOf(state.agent);
    const mode = state.mode === 'room' ? 'room' : thex(a.color)(a.name);
    const sk = state.skills.size ? dim(` [${[...state.skills].join(', ')}]`) : '';
    return `${mode}${sk}`;
  };

  console.log(`\n${bold('arachne')} ${dim('·')} ${where()} ${dim('· /help for commands')}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const prompt = () => rl.setPrompt(dim('you › '));
  const reprompt = () => { if (!rl.closed) rl.prompt(); };

  rl.on('SIGINT', () => {
    if (state.busy && state.abort) {
      state.abort.abort();
      console.log(dim('\n  (cancelled)'));
    } else {
      rl.question('', () => process.exit(0));
      process.exit(0);
    }
  });

  prompt();
  reprompt();

  let queue = Promise.resolve();
  rl.on('line', (line) => {
    queue = queue.then(() => handle(line.trim()));
  });

  async function handle(line) {
    if (!line) { reprompt(); return; }

    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      try {
        switch (cmd) {
          case 'agent':
            if (!known.includes(arg)) throw new Error(`unknown agent. try: ${known.join(', ')}`);
            state.agent = arg;
            state.mode = 'chat';
            console.log(dim(`  → ${agentOf(arg).name}`));
            break;
          case 'room':
            state.mode = 'room';
            console.log(dim('  → room (all members)'));
            break;
          case 'single':
            state.mode = 'chat';
            console.log(dim(`  → ${agentOf(state.agent).name}`));
            break;
          case 'skills':
            console.log(dim(skills.map((s) => s.id).join('  ')));
            break;
          case 'skill': {
            const id = arg.trim();
            if (!skills.some((s) => s.id === id)) throw new Error(`unknown skill: ${id}`);
            if (state.skills.has(id)) state.skills.delete(id); else state.skills.add(id);
            console.log(dim(`  → skills: ${[...state.skills].join(', ') || 'none'}`));
            break;
          }
          case 'ledger': await cmdLedger(); break;
          case 'findings': await cmdFindings(); break;
          case 'agents': await cmdAgents(); break;
          case 'new':
            state.threadId = null;
            console.log(dim('  → new thread'));
            break;
          case 'hunt': {
            if (!arg) throw new Error('/hunt <path>');
            state.busy = true;
            await cmdHuntWith(arg, state);
            state.busy = false;
            break;
          }
          case 'help': help(); break;
          case 'quit':
          case 'exit':
            rl.close();
            return;
          default:
            console.log(dim(`  unknown command /${cmd}`));
        }
      } catch (err) {
        console.log(`${red('  !')} ${err.message}`);
      }
      reprompt();
      return;
    }

    state.busy = true;
    state.abort = new AbortController();
    try {
      await loadRoster();
      const body = state.mode === 'room'
        ? { text: line, mode: 'room', members: ['scout', 'static', 'hunter'], skills: [...state.skills] }
        : { text: line, mode: 'chat', agentId: state.agent, threadId: state.threadId || undefined, skills: [...state.skills] };

      const r = new Render();
      for await (const ev of stream('/api/send', body, state.abort.signal)) {
        if (ev.type === 'thread') state.threadId = ev.threadId;
        r.ev(ev);
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.log(`${red('  !')} ${err.message}`);
    } finally {
      state.busy = false;
      state.abort = null;
      console.log();
      reprompt();
    }
  }
}

async function cmdHuntWith(target, state) {
  const r = new Render();
  for await (const ev of stream('/api/hunt', { target })) r.ev(ev);
}

// ---------------------------------------------------------------- main

const main = async () => {
  const cmd = words[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { help(); return; }
  switch (cmd) {
    case 'serve': await cmdServe(); return;
    case 'status': await cmdStatus(); return;
    case 'agents': await cmdAgents(); return;
    case 'skills': await cmdSkills(); return;
    case 'findings': await cmdFindings(); return;
    case 'ledger': await cmdLedger(); return;
    case 'engagement': await cmdEngagement(); return;
    case 'tool': await cmdTool(); return;
    case 'ask': await cmdAsk(); return;
    case 'room': await cmdRoom(); return;
    case 'hunt': await cmdHunt(); return;
    case 'chat': await cmdChat(); return;
    default:
      console.error(`unknown command: ${cmd}`);
      help();
      process.exitCode = 1;
  }
};

main().catch((err) => {
  if (err instanceof Unreachable) console.error(`\n${err.message}\n`);
  else console.error(`\n${red('error')} ${err.message}\n`);
  process.exitCode = 1;
});
