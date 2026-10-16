// Spark's command engine. Plain JavaScript that runs inside the app's web view
// (and in Node for the tests). Everything that touches the computer goes
// through `ctx`, which the app (bar.js) or the tests provide:
//
// ctx = {
//   platform,                       'windows' | 'macos' | 'linux' | 'test'
//   getConfig(),                    current config object
//   openUrl(url), openTarget(text)  open a website / a file, folder or app (-> true/false)
//   openFolder(kind),               downloads | desktop | documents | pictures | music | videos | data | config
//   files: { read(name), write(name, text), append(name, text) }   files in Spark's data folder
//   clipboard: { read(), write(text) }, clipHistory(),
//   http(method, url, body?) -> { status, body },
//   sys: { info(), localIp(), apps(), lock() },
//   post(text), alert(text), alertLater(ms, text), after(ms, fn),
//   quit(), openSettings(), reload(), importModule(code)
// }

const FAILURE = /^(Usage|Couldn't|Error)/;
const MAX_EXPONENT = 1000;
const MAX_RESULT_BITS = 14000;

// ---------------------------------------------------------------- calculator
// A tiny recursive-descent parser. Input is never run as code: anything that
// is not a number, an operator or a parenthesis is rejected. Integers use
// BigInt so results stay exact; decimals use Number.

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|(\*\*|\/\/|[-+*/%^()]))/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(pos))) break;
      throw new Error(`unsupported input near "${src.slice(pos, pos + 10).trim()}"`);
    }
    pos = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: 'num', v: /^\d+$/.test(m[1]) ? BigInt(m[1]) : parseFloat(m[1]) });
    else tokens.push({ t: 'op', v: m[2] === '^' ? '**' : m[2] });
  }
  return tokens;
}

const bothBig = (a, b) => typeof a === 'bigint' && typeof b === 'bigint';
const num = (x) => Number(x);
const bitLength = (n) => (n < 0n ? -n : n).toString(2).length;

function applyOp(op, a, b) {
  const zero = () => { throw new Error('division by zero'); };
  switch (op) {
    case '+': return bothBig(a, b) ? a + b : num(a) + num(b);
    case '-': return bothBig(a, b) ? a - b : num(a) - num(b);
    case '*': return bothBig(a, b) ? a * b : num(a) * num(b);
    case '/':
      if (num(b) === 0) zero();
      return bothBig(a, b) && a % b === 0n ? a / b : num(a) / num(b);
    case '//':
      if (num(b) === 0) zero();
      if (bothBig(a, b)) {
        let q = a / b;
        if (a % b !== 0n && (a < 0n) !== (b < 0n)) q -= 1n;
        return q;
      }
      return Math.floor(num(a) / num(b));
    case '%':
      if (num(b) === 0) zero();
      if (bothBig(a, b)) return ((a % b) + b) % b; // Python-style: sign follows the divisor
      return num(a) - num(b) * Math.floor(num(a) / num(b));
    case '**': {
      if (Math.abs(num(b)) > MAX_EXPONENT) throw new Error(`exponent too large (max ${MAX_EXPONENT})`);
      if (bothBig(a, b) && b >= 0n) {
        if (bitLength(a) * num(b) > MAX_RESULT_BITS) throw new Error('result too large');
        return a ** b;
      }
      const r = Math.pow(num(a), num(b));
      if (Number.isNaN(r)) throw new Error('result is not a real number');
      return r;
    }
    default: throw new Error('unsupported operator');
  }
}

export function safeEval(expr) {
  expr = String(expr).trim();
  if (!expr) throw new Error('nothing to calculate');
  if (expr.length > 200) throw new Error('expression too long');
  const tokens = tokenize(expr);
  let i = 0;
  const isOp = (...ops) => tokens[i] && tokens[i].t === 'op' && ops.includes(tokens[i].v);

  const parseExpr = () => {
    let left = parseTerm();
    while (isOp('+', '-')) left = applyOp(tokens[i++].v, left, parseTerm());
    return left;
  };
  const parseTerm = () => {
    let left = parseUnary();
    while (isOp('*', '/', '//', '%')) left = applyOp(tokens[i++].v, left, parseUnary());
    return left;
  };
  const parseUnary = () => { // unary binds looser than ** (so -2**2 = -4, like Python)
    if (isOp('+')) { i++; return parseUnary(); }
    if (isOp('-')) { i++; return -parseUnary(); }
    return parsePower();
  };
  const parsePower = () => {
    const base = parsePrimary();
    if (isOp('**')) { i++; return applyOp('**', base, parseUnary()); }
    return base;
  };
  const parsePrimary = () => {
    const tok = tokens[i++];
    if (!tok) throw new Error('unexpected end of expression');
    if (tok.t === 'num') return tok.v;
    if (tok.v === '(') {
      const v = parseExpr();
      if (!isOp(')')) throw new Error('missing )');
      i++;
      return v;
    }
    throw new Error(`unexpected "${tok.v}"`);
  };

  const result = parseExpr();
  if (i < tokens.length) throw new Error(`unexpected "${tokens[i].v}"`);
  if (typeof result === 'number' && !Number.isFinite(result)) throw new Error('result is too large');
  return result;
}

// Whole numbers without ".0"; decimals rounded to 12 significant digits.
export function formatNumber(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v === 0 ? 0 : v);
  return String(Number(v.toPrecision(12)));
}

// ------------------------------------------------------------------- helpers
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const lines = (text) => String(text || '').split(/\r?\n/).filter(Boolean);
const enc = new TextEncoder();

function randomInt(min, maxExclusive) { // unbiased, crypto-strength
  const range = maxExclusive - min;
  if (range <= 0) return min;
  const limit = Math.floor(0x100000000 / range) * range;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return min + (buf[0] % range);
}

const toBase64 = (text) => btoa(Array.from(enc.encode(text), (b) => String.fromCharCode(b)).join(''));
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

async function digest(algo, text) {
  const buf = await crypto.subtle.digest(algo, enc.encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

const UNITS = {
  length: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 },
  mass: { mg: 1e-6, g: 0.001, kg: 1, t: 1000, oz: 0.028349523, lb: 0.45359237 },
  volume: { ml: 0.001, l: 1, tsp: 0.00492892, tbsp: 0.0147868, cup: 0.236588, pt: 0.473176, gal: 3.78541 },
  data: { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 },
  time: { s: 1, min: 60, h: 3600, d: 86400, wk: 604800 },
};

const TIME_ZONES = {
  london: 'Europe/London', paris: 'Europe/Paris', berlin: 'Europe/Berlin', istanbul: 'Europe/Istanbul',
  ankara: 'Europe/Istanbul', moscow: 'Europe/Moscow', dubai: 'Asia/Dubai', delhi: 'Asia/Kolkata',
  mumbai: 'Asia/Kolkata', tokyo: 'Asia/Tokyo', seoul: 'Asia/Seoul', beijing: 'Asia/Shanghai',
  shanghai: 'Asia/Shanghai', singapore: 'Asia/Singapore', sydney: 'Australia/Sydney',
  nyc: 'America/New_York', 'new york': 'America/New_York', la: 'America/Los_Angeles',
  'los angeles': 'America/Los_Angeles', chicago: 'America/Chicago', toronto: 'America/Toronto',
  'sao paulo': 'America/Sao_Paulo', utc: 'UTC',
};

const EMOJI = {
  smile: '😄', laugh: '😂', wink: '😉', heart: '❤️', fire: '🔥', ok: '👌', thumbs: '👍', up: '👍',
  down: '👎', clap: '👏', party: '🎉', rocket: '🚀', star: '⭐', check: '✅', x: '❌', eyes: '👀',
  think: '🤔', cry: '😢', cool: '😎', skull: '💀', pray: '🙏', wave: '👋', sparkles: '✨',
  hundred: '💯', coffee: '☕',
};

// ------------------------------------------------------------------- engine
export function createEngine(ctx) {
  const commands = new Map(); // primary name -> command (used by help, so no alias dupes)
  const lookup = new Map();   // name or alias -> command

  // Register a command. fn(arg, spark) returns a string, null, or a Promise of those.
  // opts: { help, aliases, quiet } - quiet commands hide the bar after they succeed.
  function command(name, opts, fn) {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    const cmd = {
      name: String(name).toLowerCase(),
      help: opts.help || '',
      aliases: (opts.aliases || []).map((a) => String(a).toLowerCase()),
      quiet: !!opts.quiet,
      fn,
    };
    commands.set(cmd.name, cmd);
    for (const key of [cmd.name, ...cmd.aliases]) lookup.set(key, cmd);
  }

  // What commands and plugins receive as their second argument.
  const spark = {
    command,
    post: (text) => ctx.post(text),
    alert: (text) => ctx.alert(text),
    after: (ms, fn) => ctx.after(ms, fn),
    get config() { return ctx.getConfig(); },
    http: (method, url, body) => ctx.http(method, url, body),
    clipboard: ctx.clipboard,
  };

  async function execute(input) {
    const line = String(input).trim();
    let word;
    let arg;
    if (line.startsWith('=')) { word = '='; arg = line.slice(1).trim(); } // "=2+2" works without a space
    else {
      const m = line.match(/^(\S+)\s*([\s\S]*)$/);
      word = m[1].toLowerCase();
      arg = m[2].trim();
    }
    let cmd = lookup.get(word);
    if (!cmd) { cmd = lookup.get('open'); arg = line; } // unknown first word: open the whole thing
    try {
      const text = await cmd.fn(arg, spark);
      const out = text === undefined ? null : text;
      return { name: cmd.name, text: out, hide: out === null || (cmd.quiet && !FAILURE.test(out)) };
    } catch (err) {
      return { name: cmd.name, text: `Error: ${err && err.message ? err.message : err}`, hide: false };
    }
  }

  // plugins: [{ file, code }]. A broken plugin is reported, never fatal.
  async function loadPlugins(plugins) {
    const errors = [];
    for (const { file, code } of plugins) {
      try {
        const mod = await ctx.importModule(code);
        const init = mod && (mod.default || mod.setup);
        if (typeof init !== 'function') throw new Error('must `export default function (spark) { ... }`');
        await init(spark);
      } catch (err) {
        errors.push(`${file}: ${err && err.message ? err.message : err}`);
      }
    }
    return errors;
  }

  async function launch(target) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^www\./i.test(target)) {
      await ctx.openUrl(/:\/\//.test(target) ? target : `https://${target}`);
      return `Opening ${target}`;
    }
    if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(target) && !/\.(exe|app|lnk|txt|md|pdf|docx?|xlsx?|png|jpe?g)$/i.test(target)) {
      await ctx.openUrl(`https://${target}`); // looks like example.com
      return `Opening ${target}`;
    }
    return (await ctx.openTarget(target)) ? `Opening ${target}` : `Couldn't open '${target}'`;
  }

  async function fetchText(url) {
    const res = await ctx.http('GET', url);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    return res.body;
  }

  // in the background: show "...", then post the answer when it arrives
  function background(promise, fallback) {
    Promise.resolve(promise).then((t) => ctx.post(t), () => ctx.post(fallback));
  }

  // ======================================================= the basics
  command('open', { help: 'open <name|app|website|file> - open anything', aliases: ['o'], quiet: true }, (arg) => {
    if (!arg) return 'Usage: open <name|app|website|file>';
    const aliases = Object.fromEntries(Object.entries(ctx.getConfig().aliases || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return launch(aliases[arg.toLowerCase()] || arg);
  });

  command('calc', { help: 'calc <math> - calculator (+ - * / // % ^)', aliases: ['='] }, (arg) =>
    `${arg} = ${formatNumber(safeEval(arg))}`);

  command('help', { help: 'help [word] - list or search commands', aliases: ['?', 'commands'] }, (arg) => {
    const all = [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
    const found = arg ? all.filter((c) => `${c.name} ${c.aliases.join(' ')} ${c.help}`.toLowerCase().includes(arg.toLowerCase())) : all;
    if (!found.length) return `No command matches '${arg}'`;
    return found.map((c) => `${c.help || c.name}${c.aliases.length ? `  (${c.aliases.join(', ')})` : ''}`).join('\n');
  });

  command('settings', { help: 'settings - shortcut, quick links, startup, Ollama', aliases: ['config', 'prefs'] }, async (arg) => {
    if (arg.toLowerCase() === 'file') { await ctx.openFolder('config'); return 'Opening config file'; }
    ctx.openSettings();
    return null;
  });
  command('reload', { help: 'reload - re-read settings and plugins', aliases: ['refresh'] }, () => ctx.reload());
  command('quit', { help: 'quit - close Spark', aliases: ['exit'] }, () => { ctx.quit(); return null; });

  // ======================================================= notes & to-dos
  command('note', { help: 'note <text> - save a quick note', aliases: ['n'], quiet: true }, async (arg) => {
    if (!arg) return 'Usage: note <text>';
    await ctx.files.append('notes.md', `- [${stamp()}] ${arg}\n`);
    return 'Note saved';
  });
  command('notes', { help: 'notes [word] - last 6 notes, or search them' }, async (arg) => {
    let all = lines(await ctx.files.read('notes.md')).filter((l) => l.startsWith('- ['));
    if (!all.length) return 'No notes yet. Try: note buy milk';
    if (arg) {
      all = all.filter((l) => l.toLowerCase().includes(arg.toLowerCase()));
      if (!all.length) return `No notes matching '${arg}'`;
    }
    return all.slice(-6).join('\n');
  });
  command('todo', { help: 'todo <text> - add a to-do', quiet: true }, async (arg) => {
    if (!arg) return commands.get('todos').fn('');
    const list = lines(await ctx.files.read('todo.txt'));
    list.push(arg);
    await ctx.files.write('todo.txt', list.join('\n') + '\n');
    return `Added to-do #${list.length}`;
  });
  command('todos', { help: 'todos - show your to-do list' }, async () =>
    lines(await ctx.files.read('todo.txt')).map((t, i) => `${i + 1}. ${t}`).join('\n') || 'Nothing to do! 🎉');
  command('done', { help: 'done <number> - tick off a to-do', quiet: true }, async (arg) => {
    const list = lines(await ctx.files.read('todo.txt'));
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1 || n > list.length) return 'Usage: done <number>  (see todos)';
    const [gone] = list.splice(n - 1, 1);
    await ctx.files.write('todo.txt', list.map((l) => l + '\n').join(''));
    return `Done: ${gone}`;
  });

  // ======================================================= time
  command('timer', { help: 'timer <minutes> [label] - countdown with an alarm', aliases: ['t'], quiet: true }, (arg) => {
    const m = arg.match(/^(\S+)\s*([\s\S]*)$/);
    const minutes = m ? Number(m[1]) : NaN;
    if (!(minutes > 0 && minutes <= 24 * 60)) return 'Usage: timer <minutes> [label]';
    const label = (m[2] || '').trim() || 'Timer';
    ctx.alertLater(Math.round(minutes * 60000), `${label} is done!`);
    return `Timer set: ${label} in ${formatNumber(minutes)} min`;
  });
  command('remind', { help: 'remind <minutes> <text> - reminder', aliases: ['rem'], quiet: true }, (arg) =>
    commands.get('timer').fn(arg));
  command('pomodoro', { help: 'pomodoro [minutes] - focus session (default 25)', aliases: ['focus'], quiet: true }, (arg) =>
    commands.get('timer').fn(`${arg || 25} Focus session`));

  let stopwatchStart = null;
  command('stopwatch', { help: 'stopwatch - start / stop a stopwatch', aliases: ['sw'] }, () => {
    if (stopwatchStart === null) { stopwatchStart = Date.now(); return 'Stopwatch started. Run it again to stop.'; }
    const s = (Date.now() - stopwatchStart) / 1000;
    stopwatchStart = null;
    return `Stopwatch: ${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s`;
  });
  command('time', { help: 'time - date and time now', aliases: ['now', 'date'] }, () =>
    new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'medium' }));
  command('tz', { help: 'tz <city> - time in another city', aliases: ['clock'] }, (arg) => {
    if (!arg) return `Usage: tz <city>  (${Object.keys(TIME_ZONES).join(', ')})`;
    try {
      return `${arg}: ${new Date().toLocaleString('en-GB', { timeZone: TIME_ZONES[arg.toLowerCase()] || arg, weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
    } catch { return `Usage: unknown city '${arg}'. Try a zone like Europe/Madrid`; }
  });
  command('until', { help: 'until <YYYY-MM-DD> - days until (or since) a date', aliases: ['days'] }, (arg) => {
    const d = new Date(arg);
    if (!arg || Number.isNaN(d.getTime())) return 'Usage: until <YYYY-MM-DD>';
    const today = new Date(); today.setHours(0, 0, 0, 0); d.setHours(0, 0, 0, 0);
    const days = Math.round((d - today) / 86400000);
    return days === 0 ? 'That is today!' : days > 0 ? `${days} day(s) until ${arg}` : `${-days} day(s) since ${arg}`;
  });
  command('ts', { help: 'ts [unix|date] - Unix timestamp converter', aliases: ['epoch'] }, (arg) => {
    if (!arg) return String(Math.floor(Date.now() / 1000));
    if (/^\d{9,13}$/.test(arg)) {
      return new Date(arg.length > 10 ? Number(arg) : Number(arg) * 1000).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'medium' });
    }
    const d = new Date(arg);
    return Number.isNaN(d.getTime()) ? 'Usage: ts [unix seconds | date]' : String(Math.floor(d.getTime() / 1000));
  });

  // ======================================================= web search
  // A search command. With nothing typed after it, it just opens the site.
  const search = (name, help, url, aliases = []) =>
    command(name, { help, aliases, quiet: true }, async (arg) => {
      if (!arg) {
        const home = new URL(url.replace('{q}', ''));
        await ctx.openUrl(`${home.protocol}//${home.host}`);
        return `Opening ${home.host.replace(/^www\./, '')}`;
      }
      await ctx.openUrl(url.replace('{q}', encodeURIComponent(arg)));
      return `${name}: ${arg}`;
    });
  search('g', 'g <search> - Google', 'https://www.google.com/search?q={q}', ['google', 'search', 'gg']);
  search('yt', 'yt <search> - YouTube', 'https://www.youtube.com/results?search_query={q}', ['youtube']);
  search('wiki', 'wiki <search> - Wikipedia', 'https://en.wikipedia.org/w/index.php?search={q}', ['wikipedia']);
  search('maps', 'maps <place> - Google Maps', 'https://www.google.com/maps/search/{q}', ['map']);
  search('tr', 'tr <text> - translate to English', 'https://translate.google.com/?sl=auto&tl=en&text={q}', ['translate']);
  search('define', 'define <word> - dictionary', 'https://www.google.com/search?q=define+{q}', ['dict']);
  search('img', 'img <search> - Google Images', 'https://www.google.com/search?tbm=isch&q={q}', ['images']);
  search('news', 'news <search> - Google News', 'https://news.google.com/search?q={q}');
  search('shop', 'shop <search> - Google Shopping', 'https://www.google.com/search?tbm=shop&q={q}');
  search('bing', 'bing <search> - Bing', 'https://www.bing.com/search?q={q}');
  search('ddg', 'ddg <search> - DuckDuckGo', 'https://duckduckgo.com/?q={q}', ['duckduckgo']);
  search('reddit', 'reddit <search> - Reddit', 'https://www.reddit.com/search/?q={q}');
  search('x', 'x <search> - X (Twitter)', 'https://x.com/search?q={q}', ['twitter']);
  search('amazon', 'amazon <search> - Amazon', 'https://www.amazon.com/s?k={q}');
  search('imdb', 'imdb <search> - IMDb', 'https://www.imdb.com/find/?q={q}');
  search('spotify', 'spotify <search> - Spotify', 'https://open.spotify.com/search/{q}');
  search('gh', 'gh <search> - GitHub', 'https://github.com/search?q={q}');
  search('so', 'so <search> - Stack Overflow', 'https://stackoverflow.com/search?q={q}', ['stackoverflow']);
  search('npm', 'npm <search> - npm packages', 'https://www.npmjs.com/search?q={q}');
  search('pypi', 'pypi <search> - Python packages', 'https://pypi.org/search/?q={q}');
  search('mdn', 'mdn <search> - MDN web docs', 'https://developer.mozilla.org/en-US/search?q={q}');
  search('scholar', 'scholar <search> - Google Scholar', 'https://scholar.google.com/scholar?q={q}');
  search('pinterest', 'pinterest <search> - Pinterest', 'https://www.pinterest.com/search/pins/?q={q}');
  search('ebay', 'ebay <search> - eBay', 'https://www.ebay.com/sch/i.html?_nkw={q}');
  search('steam', 'steam <search> - Steam store', 'https://store.steampowered.com/search/?term={q}');
  search('lyrics', 'lyrics <song> - find song lyrics', 'https://www.google.com/search?q={q}+lyrics');
  search('flights', 'flights <route> - Google Flights', 'https://www.google.com/travel/flights?q={q}');
  search('recipe', 'recipe <dish> - find a recipe', 'https://www.google.com/search?q={q}+recipe');
  search('chat', 'chat <question> - ask ChatGPT in the browser', 'https://chatgpt.com/?q={q}');
  search('perplexity', 'perplexity <question> - Perplexity', 'https://www.perplexity.ai/search?q={q}', ['pplx']);

  // ======================================================= online info
  command('ask', { help: 'ask <question> - ask your local AI (Ollama)', aliases: ['ai'] }, (arg) => {
    if (!arg) return 'Usage: ask <question>';
    const cfg = ctx.getConfig();
    const url = String(cfg.ollama_url || 'http://localhost:11434').replace(/\/+$/, '') + '/api/generate';
    const body = JSON.stringify({ model: cfg.ollama_model || 'llama3.1', prompt: arg, stream: false });
    background(ctx.http('POST', url, body).then((res) => {
      if (res.status === 404) return `Ollama says the model '${cfg.ollama_model}' isn't installed. Run: ollama pull ${cfg.ollama_model}`;
      if (res.status >= 400) return `Ollama returned HTTP ${res.status}.`;
      return String(JSON.parse(res.body).response || '').trim() || '(Ollama returned an empty answer)';
    }), "Couldn't reach Ollama. Is it running? Install it from ollama.com, or check the URL in settings.");
    return 'Thinking...';
  });
  command('weather', { help: 'weather <city> - weather right now', aliases: ['w'] }, (arg) => {
    if (!arg) return 'Usage: weather <city>';
    background(fetchText(`https://wttr.in/${encodeURIComponent(arg)}?format=3`).then((t) => t.trim()), "Couldn't fetch the weather (are you online?)");
    return 'Fetching weather...';
  });
  command('fx', { help: 'fx <amount> <from> <to> - currency, e.g. fx 100 usd eur', aliases: ['currency'] }, (arg) => {
    const m = arg.toLowerCase().replace(/\s+to\s+/, ' ').match(/^([\d.]+)\s+([a-z]{3})\s+([a-z]{3})$/);
    if (!m) return 'Usage: fx <amount> <from> <to>   e.g. fx 100 usd eur';
    const [, amount, from, to] = m.map((s) => s.toUpperCase());
    background(fetchText(`https://api.frankfurter.app/latest?amount=${amount}&from=${from}&to=${to}`).then((t) => {
      const d = JSON.parse(t);
      return d.rates && d.rates[to] !== undefined ? `${amount} ${from} = ${d.rates[to]} ${to}  (${d.date})` : `Unknown currency: ${from} or ${to}`;
    }), "Couldn't fetch exchange rates (unknown currency, or offline)");
    return 'Converting...';
  });
  command('myip', { help: 'myip - your public IP address' }, () => {
    background(fetchText('https://api.ipify.org').then((t) => `Public IP: ${t.trim()}`), "Couldn't reach the internet");
    return 'Checking...';
  });
  command('ping', { help: 'ping <site> - is a website up?', aliases: ['up'] }, (arg) => {
    if (!arg) return 'Usage: ping <site>';
    const url = /^https?:\/\//.test(arg) ? arg : `https://${arg}`;
    const t0 = Date.now();
    background(ctx.http('HEAD', url).then((r) => `${arg} is up (HTTP ${r.status}) in ${Date.now() - t0} ms`), `${arg} looks down or unreachable`);
    return `Pinging ${arg}...`;
  });

  // ======================================================= clipboard
  command('copy', { help: 'copy <text> - copy text', aliases: ['cp'], quiet: true }, async (arg) => {
    if (!arg) return 'Usage: copy <text>';
    await ctx.clipboard.write(arg);
    return 'Copied';
  });
  command('paste', { help: 'paste - show what you copied' }, async () => (await ctx.clipboard.read()) || '(clipboard is empty)');
  command('clips', { help: 'clips - clipboard history', aliases: ['clipboard', 'history'] }, async () => {
    const list = await ctx.clipHistory();
    if (!list.length) return 'Clipboard history is empty (it fills up as you copy things)';
    return list.map((c, i) => `${i + 1}. ${c.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n') + '\n\nclip <number> copies one again';
  });
  command('clip', { help: 'clip <number> - copy from clipboard history', quiet: true }, async (arg) => {
    const list = await ctx.clipHistory();
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1 || n > list.length) return 'Usage: clip <number>  (see clips)';
    await ctx.clipboard.write(list[n - 1]);
    return 'Copied';
  });

  // ======================================================= generators
  command('pass', { help: 'pass [length] - strong password (copied)', aliases: ['pw', 'password'] }, async (arg) => {
    const n = Math.max(6, Math.min(/^\d+$/.test(arg) ? Number(arg) : 16, 128));
    const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';
    const pw = Array.from({ length: n }, () => alphabet[randomInt(0, alphabet.length)]).join('');
    await ctx.clipboard.write(pw);
    return `${pw}\n(copied)`;
  });
  command('uuid', { help: 'uuid - random unique ID' }, () => crypto.randomUUID());
  command('rand', { help: 'rand [min] [max] - random number (1-100)', aliases: ['random'] }, (arg) => {
    const nums = arg ? arg.split(/\s+/).map(Number) : [1, 100];
    if (nums.some((n) => !Number.isInteger(n))) return 'Usage: rand [min] [max]';
    const [lo, hi] = nums.length === 1 ? [1, nums[0]] : [Math.min(nums[0], nums[1]), Math.max(nums[0], nums[1])];
    return String(randomInt(lo, hi + 1));
  });
  command('pick', { help: 'pick a, b, c - let Spark choose', aliases: ['choose'] }, (arg) => {
    const options = arg.split(/\s*(?:,|\bor\b)\s*/i).filter(Boolean);
    return options.length > 1 ? `✻ ${options[randomInt(0, options.length)]}` : 'Usage: pick pizza, burger, sushi';
  });
  command('coin', { help: 'coin - flip a coin', aliases: ['flip'] }, () => (randomInt(0, 2) ? 'Heads' : 'Tails'));
  command('dice', { help: 'dice [sides] - roll a die (6)', aliases: ['roll'] }, (arg) => {
    const sides = arg || '6';
    if (!/^\d+$/.test(sides) || Number(sides) < 2) return 'Usage: dice [sides]';
    return `d${sides}: ${randomInt(1, Number(sides) + 1)}`;
  });
  command('lorem', { help: 'lorem [words] - placeholder text (copied)' }, async (arg) => {
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');
    const n = Math.max(1, Math.min(Number(arg) || 30, 500));
    const out = Array.from({ length: n }, (_, i) => words[i % words.length]).join(' ');
    const text = out.charAt(0).toUpperCase() + out.slice(1) + '.';
    await ctx.clipboard.write(text);
    return text;
  });
  command('emoji', { help: 'emoji <name> - copy an emoji' }, async (arg) => {
    const e = EMOJI[arg.toLowerCase()];
    if (!e) return `Usage: emoji <name>  (${Object.keys(EMOJI).join(', ')})`;
    await ctx.clipboard.write(e);
    return `${e} copied`;
  });

  // ======================================================= text tools
  command('upper', { help: 'upper <text> - UPPERCASE' }, (arg) => arg.toUpperCase());
  command('lower', { help: 'lower <text> - lowercase' }, (arg) => arg.toLowerCase());
  command('title', { help: 'title <text> - Title Case' }, (arg) => arg.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()));
  command('reverse', { help: 'reverse <text> - txet esrever' }, (arg) => [...arg].reverse().join(''));
  command('slug', { help: 'slug <text> - url-friendly-text' }, (arg) =>
    arg.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  command('count', { help: 'count <text> - count words and letters' }, (arg) =>
    `${arg.split(/\s+/).filter(Boolean).length} words, ${arg.length} characters, ${arg ? arg.split(/\r?\n/).length : 0} line(s)`);
  command('json', { help: 'json [text] - tidy JSON (or the clipboard)' }, async (arg) =>
    JSON.stringify(JSON.parse(arg || (await ctx.clipboard.read())), null, 2));
  command('b64', { help: 'b64 <text> - base64 encode' }, (arg) => toBase64(arg));
  command('unb64', { help: 'unb64 <text> - base64 decode' }, (arg) => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(arg)) throw new Error('not valid base64');
    return fromBase64(arg);
  });
  command('hash', { help: 'hash <text> - SHA-1 / SHA-256 / SHA-512' }, async (arg) =>
    (await Promise.all(['SHA-1', 'SHA-256', 'SHA-512'].map(async (a) => `${a.toLowerCase()}: ${await digest(a, arg)}`))).join('\n'));
  command('urlenc', { help: 'urlenc <text> - URL-encode' }, (arg) => encodeURIComponent(arg));
  command('urldec', { help: 'urldec <text> - URL-decode' }, (arg) => decodeURIComponent(arg));

  // ======================================================= converters
  command('conv', { help: 'conv <value> <from> <to> - units, e.g. conv 5 km mi', aliases: ['convert'] }, (arg) => {
    const parts = arg.toLowerCase().replace(/\s+to\s+/, ' ').split(/\s+/);
    if (parts.length !== 3 || Number.isNaN(Number(parts[0]))) return 'Usage: conv <value> <from> <to>   e.g. conv 5 km mi';
    const value = Number(parts[0]);
    const [, src, dst] = parts;
    let result;
    if (/^[cfk]$/.test(src) && /^[cfk]$/.test(dst)) {
      const kelvin = { c: value + 273.15, f: ((value - 32) * 5) / 9 + 273.15, k: value }[src];
      result = { c: kelvin - 273.15, f: ((kelvin - 273.15) * 9) / 5 + 32, k: kelvin }[dst];
    } else {
      const table = Object.values(UNITS).find((u) => src in u && dst in u);
      if (!table) return `Usage: can't convert ${src} to ${dst}`;
      result = (value * table[src]) / table[dst];
    }
    return `${formatNumber(value)} ${src} = ${formatNumber(Math.round(result * 1e6) / 1e6)} ${dst}`;
  });
  command('pct', { help: 'pct <x> of <y> - percentages', aliases: ['percent'] }, (arg) => {
    let m = arg.match(/^([\d.]+)\s*%?\s+of\s+([\d.]+)$/i);
    if (m) return `${m[1]}% of ${m[2]} = ${formatNumber((Number(m[1]) * Number(m[2])) / 100)}`;
    m = arg.match(/^([\d.]+)\s+is\s+what\s*%?\s*of\s+([\d.]+)$/i) || arg.match(/^([\d.]+)\s*\/\s*([\d.]+)$/);
    if (m) return `${m[1]} is ${formatNumber(Math.round((Number(m[1]) / Number(m[2])) * 10000) / 100)}% of ${m[2]}`;
    return 'Usage: pct 15 of 80   or   pct 12 / 48';
  });
  command('tip', { help: 'tip <bill> [percent] [people] - split a bill' }, (arg) => {
    const [bill, pctArg = 15, people = 1] = arg.split(/\s+/).map(Number);
    if (!(bill > 0) || !(people >= 1)) return 'Usage: tip <bill> [percent] [people]';
    const tip = (bill * pctArg) / 100;
    return `Tip ${formatNumber(Math.round(tip * 100) / 100)} · total ${formatNumber(Math.round((bill + tip) * 100) / 100)}` +
      (people > 1 ? ` · each ${formatNumber(Math.round(((bill + tip) / people) * 100) / 100)}` : '');
  });
  command('color', { help: 'color <#hex | r,g,b> - color converter', aliases: ['colour'] }, (arg) => {
    let rgb;
    const hex = arg.replace('#', '');
    if (/^[0-9a-f]{3}$/i.test(hex)) rgb = [...hex].map((c) => parseInt(c + c, 16));
    else if (/^[0-9a-f]{6}$/i.test(hex)) rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    else if (/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(arg)) rgb = arg.split(',').map(Number);
    else return 'Usage: color <#hex | r,g,b>';
    const [r, g, b] = rgb.map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
    }
    return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}\nrgb(${rgb.join(', ')})\nhsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
  });

  // ======================================================= your computer
  const folders = { downloads: 'Downloads', desktop: 'Desktop', documents: 'Documents', pictures: 'Pictures', music: 'Music', videos: 'Videos' };
  for (const [kind, label] of Object.entries(folders)) {
    command(kind, { help: `${kind} - open your ${label} folder`, aliases: kind === 'documents' ? ['docs'] : kind === 'pictures' ? ['pics'] : [], quiet: true },
      async () => { await ctx.openFolder(kind); return `Opening ${label}`; });
  }
  command('data', { help: "data - open Spark's folder (notes, to-dos, plugins)", quiet: true }, async () => {
    await ctx.openFolder('data');
    return 'Opening Spark data folder';
  });
  command('apps', { help: 'apps - list open windows', aliases: ['windows'] }, () => {
    background(ctx.sys.apps().then((list) => list.join('\n') || 'No open windows found'), "Couldn't list windows on this system");
    return 'Looking...';
  });
  command('sysinfo', { help: 'sysinfo - about this computer', aliases: ['sys'] }, async () => {
    const i = await ctx.sys.info();
    return [`${i.os} (${i.arch})`, `Computer: ${i.hostname}`, `CPU threads: ${i.cpus}`, `Spark ${i.version}`].join('\n');
  });
  command('ip', { help: "ip - this computer's local IP" }, () => ctx.sys.localIp());
  command('lock', { help: 'lock - lock the screen', quiet: true }, async () =>
    ((await ctx.sys.lock()) ? 'Locking...' : "Couldn't lock the screen on this system"));

  // ======================================================= knowledge & fun (online)
  command('whatis', { help: 'whatis <topic> - short Wikipedia summary', aliases: ['who', 'about'] }, (arg) => {
    if (!arg) return 'Usage: whatis <topic>';
    background(fetchText(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(arg.replace(/\s+/g, '_'))}`)
      .then((t) => JSON.parse(t).extract || `Nothing found for '${arg}'`), `Nothing found for '${arg}'`);
    return 'Looking it up...';
  });
  command('meaning', { help: 'meaning <word> - dictionary definition', aliases: ['def'] }, (arg) => {
    if (!arg) return 'Usage: meaning <word>';
    background(fetchText(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(arg)}`).then((t) => {
      const entry = JSON.parse(t)[0];
      const out = [entry.word + (entry.phonetic ? `  ${entry.phonetic}` : '')];
      for (const m of entry.meanings.slice(0, 3)) {
        out.push(`${m.partOfSpeech}: ${m.definitions[0].definition}`);
      }
      return out.join('\n');
    }), `No definition found for '${arg}'`);
    return 'Looking it up...';
  });
  command('joke', { help: 'joke - a random dad joke' }, () => {
    background(ctx.http('GET', 'https://icanhazdadjoke.com/').then((r) => {
      try { return JSON.parse(r.body).joke; } catch { return r.body.trim(); }
    }), "Couldn't fetch a joke right now");
    return 'Thinking of one...';
  });
  command('fact', { help: 'fact - a random fun fact' }, () => {
    background(fetchText('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en').then((t) => JSON.parse(t).text), "Couldn't fetch a fact right now");
    return 'Finding a fact...';
  });
  command('quote', { help: 'quote - a random quote', aliases: ['inspire'] }, () => {
    background(fetchText('https://zenquotes.io/api/random').then((t) => {
      const [q] = JSON.parse(t);
      return `“${q.q}”\n— ${q.a}`;
    }), "Couldn't fetch a quote right now");
    return 'Finding a quote...';
  });
  command('qr', { help: 'qr <text or link> - show a QR code', quiet: true }, async (arg) => {
    const text = arg || (await ctx.clipboard.read());
    if (!text) return 'Usage: qr <text or link>';
    await ctx.openUrl(`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(text)}`);
    return 'Opening QR code';
  });

  // ======================================================= numbers & dates
  const nums = (arg) => arg.split(/[\s,;]+/).filter(Boolean).map(Number);
  command('sum', { help: 'sum <numbers> - add a list of numbers', aliases: ['total'] }, (arg) => {
    const n = nums(arg);
    if (!n.length || n.some(Number.isNaN)) return 'Usage: sum 4 8 15 16';
    return `Sum: ${formatNumber(Math.round(n.reduce((a, b) => a + b, 0) * 1e9) / 1e9)}`;
  });
  command('avg', { help: 'avg <numbers> - average, min, max', aliases: ['average', 'mean'] }, (arg) => {
    const n = nums(arg);
    if (!n.length || n.some(Number.isNaN)) return 'Usage: avg 4 8 15 16';
    const mean = n.reduce((a, b) => a + b, 0) / n.length;
    const sorted = [...n].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return `Average ${formatNumber(Math.round(mean * 1e6) / 1e6)} · median ${formatNumber(median)} · min ${formatNumber(sorted[0])} · max ${formatNumber(sorted.at(-1))}`;
  });
  command('hex', { help: 'hex <number> - decimal to hex / binary', aliases: ['bin', 'base'] }, (arg) => {
    const s = arg.trim().toLowerCase();
    let n;
    if (/^0x[0-9a-f]+$/.test(s)) n = BigInt(s);
    else if (/^0b[01]+$/.test(s)) n = BigInt(s);
    else if (/^\d+$/.test(s)) n = BigInt(s);
    else return 'Usage: hex 255   or   hex 0xff   or   hex 0b1010';
    return `dec ${n.toString(10)}\nhex 0x${n.toString(16)}\nbin 0b${n.toString(2)}\noct 0o${n.toString(8)}`;
  });
  command('roman', { help: 'roman <number|numeral> - Roman numerals' }, (arg) => {
    const table = [['M', 1000], ['CM', 900], ['D', 500], ['CD', 400], ['C', 100], ['XC', 90], ['L', 50], ['XL', 40], ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]];
    if (/^\d+$/.test(arg)) {
      let n = Number(arg);
      if (n < 1 || n > 3999) return 'Usage: roman 1-3999';
      let out = '';
      for (const [r, v] of table) while (n >= v) { out += r; n -= v; }
      return out;
    }
    const s = arg.toUpperCase();
    if (!/^[MDCLXVI]+$/.test(s)) return 'Usage: roman 2026   or   roman MMXXVI';
    let total = 0;
    let i = 0;
    for (const [r, v] of table) while (s.startsWith(r, i)) { total += v; i += r.length; }
    return i === s.length ? String(total) : 'Usage: that is not a valid Roman numeral';
  });
  command('bmi', { help: 'bmi <kg> <cm> - body mass index' }, (arg) => {
    const [kg, cm] = nums(arg);
    if (!(kg > 0 && cm > 0)) return 'Usage: bmi <kg> <cm>   e.g. bmi 70 175';
    const bmi = kg / (cm / 100) ** 2;
    const label = bmi < 18.5 ? 'underweight' : bmi < 25 ? 'healthy' : bmi < 30 ? 'overweight' : 'obese';
    return `BMI ${bmi.toFixed(1)} (${label})`;
  });
  command('age', { help: 'age <YYYY-MM-DD> - how old, next birthday' }, (arg) => {
    const born = new Date(arg);
    if (!arg || Number.isNaN(born.getTime())) return 'Usage: age <YYYY-MM-DD>';
    const now = new Date();
    let years = now.getFullYear() - born.getFullYear();
    const next = new Date(now.getFullYear(), born.getMonth(), born.getDate());
    if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) next.setFullYear(next.getFullYear() + 1);
    if (now < new Date(now.getFullYear(), born.getMonth(), born.getDate())) years -= 1;
    const days = Math.round((next - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    return `${years} years old · next birthday in ${days} day(s)`;
  });
  command('week', { help: 'week - week number and day of the year' }, () => {
    const d = new Date();
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const week = Math.ceil(((t - new Date(Date.UTC(t.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7);
    const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
    return `Week ${week} · day ${doy} of ${d.getFullYear()}`;
  });
  command('cal', { help: 'cal - this month as a calendar', aliases: ['month'] }, () => {
    const d = new Date();
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    // 4 characters per day; today is shown as [17]
    const out = [first.toLocaleString('en-GB', { month: 'long', year: 'numeric' }), ' Mo  Tu  We  Th  Fr  Sa  Su'];
    let row = '    '.repeat((first.getDay() + 6) % 7);
    for (let i = 1; i <= days; i++) {
      row += (i === d.getDate() ? `[${i}]` : ` ${i} `).padStart(4);
      if ((first.getDay() + 6 + i) % 7 === 0) { out.push(row.trimEnd()); row = ''; }
    }
    if (row) out.push(row.trimEnd());
    return out.join('\n');
  });
  command('moon', { help: 'moon - phase of the moon tonight' }, () => {
    const synodic = 29.530588853;
    const days = ((Date.now() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000) % synodic;
    const phases = ['🌑 New moon', '🌒 Waxing crescent', '🌓 First quarter', '🌔 Waxing gibbous', '🌕 Full moon', '🌖 Waning gibbous', '🌗 Last quarter', '🌘 Waning crescent'];
    return `${phases[Math.round((days / synodic) * 8) % 8]} (day ${Math.floor(days)} of ${Math.round(synodic)})`;
  });
  command('compound', { help: 'compound <amount> <rate%> <years> - savings growth', aliases: ['interest'] }, (arg) => {
    const [p, r, y] = nums(arg.replace(/%/g, ''));
    if (!(p > 0 && r >= 0 && y > 0)) return 'Usage: compound 1000 5 10';
    const total = p * (1 + r / 100) ** y;
    return `${formatNumber(p)} at ${r}% for ${y} years → ${formatNumber(Math.round(total * 100) / 100)} (+${formatNumber(Math.round((total - p) * 100) / 100)})`;
  });
  command('pin', { help: 'pin [digits] - random PIN code (copied)' }, async (arg) => {
    const n = Math.max(3, Math.min(Number(arg) || 4, 12));
    const pin = Array.from({ length: n }, () => randomInt(0, 10)).join('');
    await ctx.clipboard.write(pin);
    return `${pin}  (copied)`;
  });

  // ======================================================= text, part 2
  const MORSE = { a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.' };
  command('morse', { help: 'morse <text> - to and from Morse code' }, (arg) => {
    if (!arg) return 'Usage: morse <text>';
    if (/^[.\-\s/]+$/.test(arg)) {
      const back = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
      return arg.split(/\s*\/\s*/).map((w) => w.split(/\s+/).map((c) => back[c] || '?').join('')).join(' ');
    }
    return arg.toLowerCase().split(/\s+/).map((w) => [...w].map((c) => MORSE[c] || '').filter(Boolean).join(' ')).join(' / ');
  });
  const NATO = 'Alfa Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey X-ray Yankee Zulu'.split(' ');
  command('nato', { help: 'nato <text> - spell it out (Alfa, Bravo...)', aliases: ['spell'] }, (arg) =>
    [...arg.toUpperCase()].map((c) => (c >= 'A' && c <= 'Z' ? NATO[c.charCodeAt(0) - 65] : c === ' ' ? '·' : c)).join(' ') || 'Usage: nato <text>');
  command('sortlines', { help: 'sortlines - sort the lines on your clipboard', aliases: ['sort'] }, async () => {
    const text = await ctx.clipboard.read();
    if (!text) return 'Usage: copy some lines first, then run sortlines';
    const sorted = text.split(/\r?\n/).sort((a, b) => a.localeCompare(b)).join('\n');
    await ctx.clipboard.write(sorted);
    return `${sorted}\n\n(sorted and copied)`;
  });
  command('dedupe', { help: 'dedupe - remove duplicate lines on your clipboard', aliases: ['unique'] }, async () => {
    const text = await ctx.clipboard.read();
    if (!text) return 'Usage: copy some lines first, then run dedupe';
    const out = [...new Set(text.split(/\r?\n/))].join('\n');
    await ctx.clipboard.write(out);
    return `${out}\n\n(duplicates removed and copied)`;
  });
  command('regex', { help: 'regex <pattern> <text> - test a regular expression', aliases: ['re'] }, (arg) => {
    const m = arg.match(/^(\S+)\s+([\s\S]+)$/);
    if (!m) return 'Usage: regex \\d+ order 66';
    const re = new RegExp(m[1].replace(/^\/|\/[gimsuy]*$/g, ''), 'g');
    const found = [...m[2].matchAll(re)].map((x) => x[0]);
    return found.length ? `${found.length} match(es): ${found.join(', ')}` : 'No matches';
  });

  // ======================================================= suggestions
  // As-you-type help: best matches for the first word, plus a live answer
  // when the input looks like math.
  function suggest(input) {
    const text = String(input).trim();
    if (!text) return { items: [], preview: null };
    let preview = null;
    const mathish = text.startsWith('=') ? text.slice(1)
      : /^[\d\s.+\-*/%^()]+$/.test(text) && /\d\s*[-+*/%^]/.test(text) ? text : null;
    if (mathish) { try { preview = formatNumber(safeEval(mathish)); } catch { /* not finished yet */ } }
    if (/\s/.test(text)) return { items: [], preview }; // typing arguments: get out of the way
    const word = text.toLowerCase();
    const scored = [];
    for (const c of commands.values()) {
      const names = [c.name, ...c.aliases];
      let score = 0;
      if (names.includes(word)) score = 100;
      else if (names.some((n) => n.startsWith(word))) score = 80 - c.name.length;
      else if (word.length > 1 && c.name.includes(word)) score = 40;
      else if (word.length > 2 && c.help.toLowerCase().includes(word)) score = 20;
      if (score) scored.push({ name: c.name, help: c.help, score });
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return { items: scored.slice(0, 5), preview };
  }

  return { execute, command, loadPlugins, suggest, commands, lookup, spark };
}
