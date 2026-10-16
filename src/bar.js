// The command bar page: input, suggestions, history, output, drag.
// Commands run right here (engine.js); system work goes to the Rust core.
import { createEngine } from './engine.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const pill = $('pill');
const input = $('input');
const output = $('output');
const list = $('suggestions');
const preview = $('preview');

let config = {};
let platform = 'windows';
let engine;
let pluginNotice = null;

// ------------------------------------------------------------ engine wiring
const beep = () => {
  try {
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.6);
    osc.connect(gain).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.6);
  } catch { /* no audio device */ }
};

const ctx = {
  get platform() { return platform; },
  getConfig: () => config,
  openUrl: (url) => invoke('open_url', { url }),
  openTarget: (target) => invoke('open_target', { target }),
  openFolder: (kind) => invoke('open_folder', { kind }),
  files: {
    read: (name) => invoke('read_data', { name }),
    write: (name, text) => invoke('write_data', { name, text }),
    append: (name, text) => invoke('append_data', { name, text }),
  },
  clipboard: {
    read: () => invoke('clipboard_read'),
    write: (text) => invoke('clipboard_write', { text }),
  },
  clipHistory: () => invoke('clip_history'),
  http: (method, url, body) => invoke('http', { method, url, body: body ?? null }),
  sys: {
    info: () => invoke('sys_info'),
    localIp: () => invoke('local_ip'),
    apps: () => invoke('list_apps'),
    lock: () => invoke('lock_screen'),
  },
  post: (text) => invoke('bar_post', { text: String(text) }),
  alert: (text) => { invoke('bar_post', { text: String(text) }); beep(); },
  alertLater: (ms, text) => invoke('alert_later', { ms, text }),
  after: (ms, fn) => setTimeout(fn, ms),
  quit: () => invoke('quit'),
  openSettings: () => invoke('open_settings'),
  reload: async () => {
    const msg = await invoke('reload_config');
    await boot();
    return [msg, pluginNotice].filter(Boolean).join('\n');
  },
  importModule: async (code) => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try { return await import(url); } finally { URL.revokeObjectURL(url); }
  },
};

async function boot() {
  const state = await invoke('get_state');
  config = state.config;
  platform = state.platform;
  engine = createEngine(ctx);
  const errors = await engine.loadPlugins(await invoke('list_plugins'));
  pluginNotice = errors.length ? `Plugin errors: ${errors.join('; ')}` : null;
}

// ------------------------------------------------------------ UI
const history = [];
let histPos = 0;
let hideTimer = null;
let items = [];
let active = -1;

const fit = () => invoke('bar_resize', { height: Math.ceil(document.body.scrollHeight) });
new ResizeObserver(fit).observe(pill);
output.style.maxHeight = `${Math.round(screen.availHeight * 0.55)}px`;

// Results that line up in columns read better in a fixed-width font.
const MONO = new Set(['cal', 'hex', 'hash', 'json', 'morse', 'uuid', 'b64', 'unb64', 'color']);

function cancelHide() {
  clearTimeout(hideTimer);
  hideTimer = null;
}

function setOutput(text) {
  const t = text == null ? '' : String(text);
  output.textContent = t;
  output.hidden = !t;
  output.classList.remove('mono');
  output.classList.toggle('error', /^(Error|Couldn't)/.test(t));
  output.scrollTop = 0;
  pill.classList.toggle('busy', /\.\.\.$/.test(t)); // "Thinking...", "Looking..."
}

function renderSuggestions() {
  list.replaceChildren(...items.map((s, i) => {
    const li = document.createElement('li');
    if (i === active) li.className = 'active';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    const help = document.createElement('span');
    help.className = 'help';
    help.textContent = s.help.includes(' - ') ? s.help.split(' - ').slice(1).join(' - ') : s.help;
    li.append(name, help);
    li.addEventListener('mousedown', (e) => { e.preventDefault(); complete(i); });
    return li;
  }));
  list.hidden = items.length === 0;
}

function updateSuggestions() {
  if (!engine) return;
  const res = engine.suggest(input.value);
  preview.hidden = res.preview == null;
  preview.textContent = res.preview == null ? '' : `= ${res.preview}`;
  items = res.items;
  if (active >= items.length) active = -1;
  renderSuggestions();
}

function complete(i) {
  if (!items[i]) return;
  input.value = `${items[i].name} `;
  active = -1;
  input.focus();
  updateSuggestions();
}

async function runLine() {
  if (active >= 0 && items[active]) { complete(active); return; }
  const line = input.value.trim();
  if (!line || !engine) return;
  if (history[history.length - 1] !== line) history.push(line);
  histPos = history.length;
  items = [];
  renderSuggestions();
  preview.hidden = true;
  const res = await engine.execute(line);
  setOutput(res.text);
  output.classList.toggle('mono', MONO.has(res.name));
  if (res.hide) {
    cancelHide();
    hideTimer = setTimeout(() => invoke('bar_hide'), 700);
  } else {
    input.select();
  }
}

input.addEventListener('input', () => {
  cancelHide();
  active = -1;
  updateSuggestions();
});

input.addEventListener('keydown', (e) => {
  cancelHide();
  if (e.key === 'Enter') { e.preventDefault(); runLine(); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    if (items.length) complete(active >= 0 ? active : 0);
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    if (items.length) { // walk the suggestions (and back to "none")
      active += step;
      if (active >= items.length) active = -1;
      if (active < -1) active = items.length - 1;
      renderSuggestions();
      return;
    }
    if (!history.length) return; // otherwise: command history
    histPos = Math.max(0, Math.min(history.length, histPos + step));
    input.value = history[histPos] || '';
    input.setSelectionRange(input.value.length, input.value.length);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); invoke('bar_hide'); }
});

// Drag the bar with the middle mouse button (scroll wheel click).
let drag = null;
document.addEventListener('mousedown', (e) => {
  if (e.button !== 1) return;
  e.preventDefault(); // no autoscroll
  drag = { x: e.screenX, y: e.screenY };
  invoke('bar_drag_start');
});
document.addEventListener('mousemove', (e) => {
  if (drag) invoke('bar_drag_move', { dx: e.screenX - drag.x, dy: e.screenY - drag.y });
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 1 && drag) { drag = null; invoke('bar_drag_end'); }
});
document.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

listen('bar:show', ({ payload }) => {
  cancelHide();
  input.value = '';
  histPos = history.length;
  items = [];
  active = -1;
  renderSuggestions();
  preview.hidden = true;
  setOutput([payload, pluginNotice].filter(Boolean).join('\n'));
  pluginNotice = null;
  pill.style.animation = 'none';
  void pill.offsetWidth; // replay the pop-in animation
  pill.style.animation = '';
  input.focus();
});
listen('bar:output', ({ payload }) => { cancelHide(); setOutput(payload); });
listen('bar:beep', () => beep());
listen('config:changed', async () => { config = (await invoke('get_state')).config; });

window.addEventListener('focus', () => input.focus());
await boot();
fit();
