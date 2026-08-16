// simplewatcher self-test — no external deps. Run with: npm test
// Verifies the three behaviors that previously caused real-world damage, plus
// the payload cap that keeps watched files from flooding the context window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'src/index.ts');
const ext = (await import(EXT)).default;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function harness() {
  const injected = [];
  const handlers = {};
  const commands = {};
  const notices = [];
  const pi = {
    sendMessage(msg, opts) {
      const m = /\[simplewatcher: (.+?) changed\]/.exec(msg.content);
      injected.push({ label: m ? m[1] : '?', triggerTurn: !!opts.triggerTurn, content: msg.content });
    },
    on(evt, fn) { handlers[evt] = fn; },
    registerCommand(name, def) { commands[name] = def; },
  };
  const ctx = { ui: { notify(m, k) { notices.push({ m, k }); } } };
  return { injected, handlers, commands, notices, pi, ctx };
}

async function scenario({ agent, env = {}, files = {}, liveFile = null }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'simplewatcher-test-'));
  const inbox = path.join(home, 'Agents/_bus/inbox', agent);
  fs.mkdirSync(inbox, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(inbox, name), content);

  const saved = { HOME: process.env.HOME, SIMPLEWATCHER_AGENT: process.env.SIMPLEWATCHER_AGENT, PI_AGENT: process.env.PI_AGENT, AGENT_NAME: process.env.AGENT_NAME };
  process.env.HOME = home;
  delete process.env.SIMPLEWATCHER_AGENT;
  delete process.env.PI_AGENT;
  delete process.env.AGENT_NAME;
  Object.assign(process.env, env);

  const h = harness();
  ext(h.pi);
  await h.handlers.session_start({}, h.ctx);
  const boot = h.injected.splice(0);

  await h.handlers.session_start({}, h.ctx); // model-change re-arm must not replay
  const rearm = h.injected.splice(0);

  let live = [];
  if (liveFile) {
    fs.writeFileSync(path.join(inbox, liveFile.name), liveFile.content);
    await new Promise((r) => setTimeout(r, 700));
    live = h.injected.splice(0);
  }

  await h.handlers.session_shutdown({}, h.ctx);
  fs.rmSync(home, { recursive: true, force: true });
  if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
  for (const key of ['SIMPLEWATCHER_AGENT', 'PI_AGENT', 'AGENT_NAME']) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  return { boot, rearm, live };
}

const baseFiles = { 'a.md': 'pending a\n', 'b.md': 'pending b\n', 'c.md': 'pending c\n' };

{
  const r = await scenario({ agent: 'fabricant', files: baseFiles, liveFile: { name: 'd.md', content: 'live d\n' } });
  check('boot backlog is passive', r.boot.length === 3 && r.boot.every((i) => i.triggerTurn === false), r.boot.map((i) => i.label).join(','));
  check('model-change re-arm replays nothing', r.rearm.length === 0, `${r.rearm.length} injections`);
  check('new arrival stays active', r.live.length === 1 && r.live[0].label === 'd.md' && r.live[0].triggerTurn === true, r.live.map((i) => i.label).join(','));
}

{
  const r = await scenario({ agent: 'axiom', env: { SIMPLEWATCHER_AGENT: 'axiom' }, files: baseFiles, liveFile: { name: 'd.md', content: 'live d\n' } });
  check('env override selects agent inbox', r.boot.length === 3 && r.live.length === 1 && r.live[0].triggerTurn === true);
}

{
  const r = await scenario({ agent: 'fabricant', files: { 'big.md': 'x'.repeat(200_000) } });
  const one = r.boot[0]?.content ?? '';
  check('payload cap truncates large files', r.boot.length === 1 && one.includes('[simplewatcher: truncated big.md') && Buffer.byteLength(one, 'utf8') < 40_000, `${Buffer.byteLength(one, 'utf8')} bytes`);
}

{
  const savedCwd = process.cwd();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'simplewatcher-project-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'simplewatcher-home-'));
  const inbox = path.join(home, 'Agents/_bus/inbox/fabricant');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'pending.md'), 'persisted pending\n');

  const savedHome = process.env.HOME;
  process.env.HOME = home;
  process.env.SIMPLEWATCHER_AGENT = 'fabricant';
  process.chdir(project);
  try {
    const first = harness();
    ext(first.pi);
    await first.commands.simplewatcher.handler('~/Agents/_bus/inbox/fabricant --active --persist --global', first.ctx);
    const cfgPath = path.join(home, '.pi/agent/simplewatcher.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    check('--persist --global writes global config', cfg.watches?.some((w) => w.path === '~/Agents/_bus/inbox/fabricant' && w.mode === 'active' && w.enabled !== false));

    const second = harness();
    ext(second.pi);
    await second.handlers.session_start({}, second.ctx);
    check('session_start rehydrates persisted watch', second.injected.some((i) => i.label === 'pending.md' && i.triggerTurn === false), second.injected.map((i) => i.label).join(','));
    await second.handlers.session_shutdown({}, second.ctx);

    const bad = harness();
    ext(bad.pi);
    await bad.commands.simplewatcher.handler('/tmp --definitely-not-a-flag', bad.ctx);
    check('unknown flags are rejected', bad.notices.some((n) => n.k === 'error' && n.m.includes('unknown option')));
  } finally {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    delete process.env.SIMPLEWATCHER_AGENT;
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- master switch: /simplewatcher disable stops all watches + persists ---
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'simplewatcher-master-'));
  const inbox = path.join(home, 'Agents/_bus/inbox/fabricant');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'pending.md'), 'pending boot\n');
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  delete process.env.SIMPLEWATCHER_AGENT;
  try {
    // Session 1: boot arms the default inbox watch, then disable tears it down.
    const a = harness();
    ext(a.pi);
    await a.handlers.session_start({}, a.ctx);
    const armedBoot = a.injected.splice(0).some((i) => i.label === 'pending.md');
    await a.commands.simplewatcher.handler('disable', a.ctx);
    const disabledNotice = a.notices.some((n) => /disabled/.test(n.m));
    // A live arrival while disabled must NOT inject (watcher is closed).
    fs.writeFileSync(path.join(inbox, 'live.md'), 'live while disabled\n');
    await new Promise((r) => setTimeout(r, 700));
    const liveWhileDisabled = a.injected.splice(0);
    // addWatch while disabled is refused.
    await a.commands.simplewatcher.handler('/tmp', a.ctx);
    const refused = a.notices.some((n) => n.k === 'warning' && /disabled.*enable first/.test(n.m));
    // Bare status reflects DISABLED.
    a.notices.length = 0;
    await a.commands.simplewatcher.handler('', a.ctx);
    const statusDisabled = a.notices.some((n) => /DISABLED/.test(n.m));
    await a.handlers.session_shutdown({}, a.ctx);

    // Session 2: a fresh extension instance loads the persisted disabled state
    // and must NOT arm on session_start.
    const b = harness();
    ext(b.pi);
    await b.handlers.session_start({}, b.ctx);
    const bootAfterDisabled = b.injected.splice(0);
    // Re-enable mid-session re-arms the default inbox watch.
    await b.commands.simplewatcher.handler('enable', b.ctx);
    const enableNotice = b.notices.some((n) => /enabled.*re-armed/.test(n.m));
    // After enable, a new live arrival injects again.
    fs.writeFileSync(path.join(inbox, 'live2.md'), 'live after enable\n');
    await new Promise((r) => setTimeout(r, 700));
    const liveAfterEnable = b.injected.splice(0);
    await b.handlers.session_shutdown({}, b.ctx);

    check('disable stops live watches (no injection while disabled)', armedBoot && liveWhileDisabled.length === 0, `boot=${armedBoot} live=${liveWhileDisabled.length}`);
    check('addWatch refused while disabled', refused, JSON.stringify(a.notices.map((n) => n.m)));
    check('bare status shows DISABLED', statusDisabled);
    check('disabled persists across sessions (no boot injection)', bootAfterDisabled.length === 0, `${bootAfterDisabled.length} injections`);
    check('enable re-arms watches', enableNotice && liveAfterEnable.some((i) => i.label === 'live2.md'), `notice=${enableNotice} live=${liveAfterEnable.map((i) => i.label).join(',')}`);

    // The global config records the final enabled=true state.
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.pi/agent/simplewatcher.json'), 'utf8'));
    check('master switch persisted to global config', cfg.enabled === true, JSON.stringify(cfg.enabled));
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
