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
  const pi = {
    sendMessage(msg, opts) {
      const m = /\[simplewatcher: (.+?) changed\]/.exec(msg.content);
      injected.push({ label: m ? m[1] : '?', triggerTurn: !!opts.triggerTurn, content: msg.content });
    },
    on(evt, fn) { handlers[evt] = fn; },
    registerCommand() {},
  };
  const ctx = { ui: { notify() {} } };
  return { injected, handlers, pi, ctx };
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
