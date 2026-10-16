// Headless tests for the command engine: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, safeEval, formatNumber } from '../src/engine.js';

function setup() {
  const files = {};
  const log = { urls: [], targets: [], folders: [], posted: [], alerts: [], later: [], clip: '', http: [] };
  const config = {
    hotkey: 'Ctrl+Shift+Space',
    aliases: { github: 'https://github.com' },
    ollama_url: 'http://localhost:11434',
    ollama_model: 'llama3.1',
  };
  let httpImpl = async () => { throw new Error('offline'); };
  const engine = createEngine({
    platform: 'test',
    getConfig: () => config,
    openUrl: async (u) => log.urls.push(u),
    openTarget: async (t) => { log.targets.push(t); return t === 'notepad'; },
    openFolder: async (k) => log.folders.push(k),
    files: {
      read: async (n) => files[n] || '',
      write: async (n, t) => { files[n] = t; },
      append: async (n, t) => { files[n] = (files[n] || '') + t; },
    },
    clipboard: { read: async () => log.clip, write: async (t) => { log.clip = t; } },
    clipHistory: async () => ['first', 'second'],
    http: (...a) => { log.http.push(a); return httpImpl(...a); },
    sys: { info: async () => ({ os: 'TestOS', arch: 'x64', hostname: 'box', cpus: 4, version: '1.0.0' }), localIp: async () => '10.0.0.2', apps: async () => ['a', 'b'], lock: async () => true },
    post: (t) => log.posted.push(t),
    alert: (t) => log.alerts.push(t),
    alertLater: (ms, t) => log.later.push([ms, t]),
    after: () => {},
    quit() {}, openSettings() {}, reload: () => 'reloaded',
    importModule: (code) => import('data:text/javascript,' + encodeURIComponent(code)),
  });
  const setHttp = (fn) => { httpImpl = fn; };
  const run = async (l) => (await engine.execute(l)).text;
  const settle = async () => { for (let i = 0; i < 50 && !log.posted.length; i++) await new Promise((r) => setTimeout(r, 10)); };
  return { engine, run, log, config, files, setHttp, settle };
}

test('calc: math, exact integers, caret, = shortcut', async () => {
  const { run } = setup();
  assert.equal(await run('calc 2+3*4'), '2+3*4 = 14');
  assert.equal(await run('calc 7 // 2'), '7 // 2 = 3');
  assert.equal(await run('calc -7 % 3'), '-7 % 3 = 2');
  assert.equal(await run('calc 10/2'), '10/2 = 5');
  assert.equal(await run('calc 7/2'), '7/2 = 3.5');
  assert.equal(await run('calc 2^10'), '2^10 = 1024');
  assert.equal(await run('calc -2**2'), '-2**2 = -4');
  assert.equal(await run('calc 2**100'), '2**100 = 1267650600228229401496703205376');
  assert.equal(await run('calc 0.1+0.2'), '0.1+0.2 = 0.3');
  assert.equal(await run('= 2**3'), '2**3 = 8');
  assert.equal(await run('=2+2'), '2+2 = 4');
});

test('calc: never runs code, rejects bad input', async () => {
  const { run } = setup();
  for (const bad of ["__import__('os')", 'alert(1)', "require('fs')", 'constructor', '`x`', '[1,2]',
    'process.exit()', '2**1001', '9**9**9', '1/0', '2 +', '(1', '1)', '(-8)**0.5', '1; 2']) {
    assert.match(await run('calc ' + bad), /^Error/, bad);
  }
  assert.throws(() => safeEval('globalThis'));
  assert.equal(formatNumber(5), '5');
  assert.equal(formatNumber(10n), '10');
});

test('notes and to-dos', async () => {
  const { run } = setup();
  assert.match(await run('notes'), /No notes yet/);
  for (let i = 0; i < 8; i++) await run(`n item ${i}`);
  const list = (await run('notes')).split('\n');
  assert.equal(list.length, 6);
  assert.match(list[5], /^- \[\d{4}-\d\d-\d\d \d\d:\d\d\] item 7$/);
  assert.equal((await run('notes item 3')).split('\n').length, 1);
  await run('todo a'); await run('todo b');
  assert.equal(await run('todos'), '1. a\n2. b');
  assert.equal(await run('done 1'), 'Done: a');
  assert.equal(await run('todos'), '1. b');
  assert.match(await run('done 9'), /^Usage/);
});

test('timers go to the app scheduler; bar hides after quiet commands', async () => {
  const { engine, log } = setup();
  const res = await engine.execute('t 0.5 tea');
  assert.equal(res.hide, true);
  assert.deepEqual(log.later, [[30000, 'tea is done!']]);
  await engine.execute('pomodoro');
  assert.deepEqual(log.later[1], [25 * 60000, 'Focus session is done!']);
  const bad = await engine.execute('timer -3');
  assert.match(bad.text, /^Usage/);
  assert.equal(bad.hide, false);
});

test('help lists each command once; help <word> searches', async () => {
  const { engine, run } = setup();
  const all = (await run('help')).split('\n');
  assert.equal(all.length, engine.commands.size);
  assert.ok(engine.commands.size >= 70, `only ${engine.commands.size} commands`);
  assert.match(await run('help weather'), /^weather/);
  assert.match(await run('help zzzz'), /No command/);
});

test('opening: searches, aliases, domains, apps, failures', async () => {
  const { engine, log, config } = setup();
  await engine.execute('google hello world');
  assert.equal(log.urls.at(-1), 'https://www.google.com/search?q=hello%20world');
  await engine.execute('github');
  assert.equal(log.urls.at(-1), 'https://github.com');
  config.aliases.mysite = 'https://example.org';
  await engine.execute('MySite');
  assert.equal(log.urls.at(-1), 'https://example.org');
  await engine.execute('example.com');
  assert.equal(log.urls.at(-1), 'https://example.com');
  assert.equal((await engine.execute('notepad')).text, 'Opening notepad');
  const fail = await engine.execute('nosuchapp');
  assert.equal(fail.text, "Couldn't open 'nosuchapp'");
  assert.equal(fail.hide, false);
  await engine.execute('downloads');
  assert.deepEqual(log.folders, ['downloads']);
});

test('errors become text; plugins load, broken ones are reported', async () => {
  const { engine } = setup();
  engine.command('boom', () => { throw new Error('kaput'); });
  assert.equal((await engine.execute('boom')).text, 'Error: kaput');
  const errors = await engine.loadPlugins([
    { file: 'good.js', code: "export default (spark) => spark.command('hello', { help: 'hello <x>' }, (a) => 'hi ' + a);" },
    { file: 'bad.js', code: "throw new Error('nope');" },
    { file: 'syntax.js', code: 'export default (' },
    { file: 'wrong.js', code: 'export const x = 1;' },
  ]);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.startsWith('bad.js: nope')));
  assert.equal((await engine.execute('hello there')).text, 'hi there');
});

test('tools: conv, pct, tip, color, base64, hash, uuid, count, rand, pick, slug', async () => {
  const { run } = setup();
  assert.equal(await run('conv 100 c f'), '100 c = 212 f');
  assert.equal(await run('conv 5 km to mi'), '5 km = 3.106856 mi');
  assert.match(await run('conv 1 kg km'), /^Usage/);
  assert.equal(await run('pct 15 of 80'), '15% of 80 = 12');
  assert.equal(await run('pct 12 / 48'), '12 is 25% of 48');
  assert.equal(await run('tip 100 20 4'), 'Tip 20 · total 120 · each 30');
  assert.equal(await run('color #fff'), '#ffffff\nrgb(255, 255, 255)\nhsl(0, 0%, 100%)');
  assert.equal(await run('unb64 ' + (await run('b64 héllo ✻'))), 'héllo ✻');
  assert.match(await run('hash hi'), /sha-256: 8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4/);
  assert.equal((await run('uuid')).length, 36);
  assert.equal(await run('count a b c'), '3 words, 5 characters, 1 line(s)');
  assert.equal(await run('rand 5 5'), '5');
  assert.match(await run('pick tea, coffee'), /^✻ (tea|coffee)$/);
  assert.equal(await run('slug Héllo World!'), 'hello-world');
  assert.equal(await run('title hello big world'), 'Hello Big World');
});

test('clipboard: copy, paste, history, password', async () => {
  const { run, log } = setup();
  await run('copy hello');
  assert.equal(await run('paste'), 'hello');
  assert.match(await run('clips'), /^1\. first\n2\. second/);
  await run('clip 2');
  assert.equal(log.clip, 'second');
  assert.match(await run('pass 20'), /\(copied\)$/);
  assert.equal(log.clip.length, 20);
});

test('online commands post their answer later; offline is friendly', async () => {
  const s = setup();
  assert.equal(await s.run('ask hi'), 'Thinking...');
  await s.settle();
  assert.match(s.log.posted[0], /Couldn't reach Ollama/);

  const t = setup();
  t.setHttp(async () => ({ status: 200, body: JSON.stringify({ response: ' Hello! ' }) }));
  await t.run('ask hi');
  await t.settle();
  assert.equal(t.log.posted[0], 'Hello!');
  assert.equal(t.log.http[0][1], 'http://localhost:11434/api/generate');

  const u = setup();
  u.setHttp(async () => ({ status: 404, body: '' }));
  await u.run('ai hi');
  await u.settle();
  assert.match(u.log.posted[0], /ollama pull llama3\.1/);
});

test('more tools: numbers, dates, text', async () => {
  const { run, log, engine } = setup();
  assert.equal(await run('sum 1 2 3.5'), 'Sum: 6.5');
  assert.equal(await run('avg 1 2 3 10'), 'Average 4 · median 2.5 · min 1 · max 10');
  assert.equal(await run('hex 255'), 'dec 255\nhex 0xff\nbin 0b11111111\noct 0o377');
  assert.equal(await run('roman 2026'), 'MMXXVI');
  assert.equal(await run('roman MMXXVI'), '2026');
  assert.equal(await run('bmi 70 175'), 'BMI 22.9 (healthy)');
  assert.equal(await run('morse sos'), '... --- ...');
  assert.equal(await run('morse ... --- ...'), 'sos');
  assert.equal(await run('nato ab c'), 'Alfa Bravo · Charlie');
  assert.equal(await run('regex \\d+ order 66 and 7'), '2 match(es): 66, 7');
  assert.match(await run('compound 1000 10 2'), /→ 1210 \(\+210\)/);
  assert.match(await run('week'), /^Week \d+ · day \d+ of \d{4}$/);
  assert.match(await run('cal'), /Mo  Tu  We  Th  Fr  Sa  Su/);
  assert.match(await run('moon'), /moon|crescent|quarter|gibbous/);
  assert.match(await run('age 2000-01-01'), /^\d+ years old/);
  log.clip = 'b\na\nb';
  await run('dedupe');
  assert.equal(log.clip, 'b\na');
  await run('sortlines');
  assert.equal(log.clip, 'a\nb');
  assert.match(await run('pin 6'), /^\d{6} {2}\(copied\)$/);
  const home = await engine.execute('yt');
  assert.equal(home.text, 'Opening youtube.com');
  assert.equal(log.urls.at(-1), 'https://www.youtube.com');
  assert.ok(engine.commands.size >= 110, `only ${engine.commands.size} commands`);
});

test('suggestions and live math preview', async () => {
  const { engine } = setup();
  assert.equal(engine.suggest('wea').items[0].name, 'weather');
  assert.equal(engine.suggest('google').items[0].name, 'g');
  assert.equal(engine.suggest('2+2*3').preview, '8');
  assert.equal(engine.suggest('=2^8').preview, '256');
  assert.equal(engine.suggest('2+').preview, null);
  assert.deepEqual(engine.suggest('weather lon').items, []);
  assert.deepEqual(engine.suggest('').items, []);
});
