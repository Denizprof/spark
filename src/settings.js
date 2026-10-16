// Settings window. Closing it (or "Save & start") saves and activates Spark.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const keysBtn = $('hotkey');
const links = $('links');
const statusEl = $('status');
let platform = 'windows';
let hotkey = 'Ctrl+Shift+Space';
let recording = false;
let saving = false;

// ---------------------------------------------------------------- shortcut
const NAMED = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Backquote: 'Backquote', Minus: 'Minus', Equal: 'Equal', BracketLeft: 'BracketLeft', BracketRight: 'BracketRight',
  Backslash: 'Backslash', Semicolon: 'Semicolon', Quote: 'Quote', Comma: 'Comma', Period: 'Period', Slash: 'Slash',
};
const PRETTY = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Cmd: '⌘', Super: '⊞' };

function shortcutFrom(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (NAMED[e.code]) key = NAMED[e.code];
  if (!key) return null; // only a modifier so far
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push(platform === 'macos' ? 'Cmd' : 'Super');
  if (!mods.length && !/^F\d/.test(key)) return null; // needs a modifier, except F-keys
  return [...mods, key].join('+');
}

function renderKeys() {
  keysBtn.classList.toggle('recording', recording);
  if (recording) {
    keysBtn.innerHTML = '<span class="wait">Press keys…</span>';
    return;
  }
  keysBtn.replaceChildren(...hotkey.split('+').map((k) => {
    const kbd = document.createElement('kbd');
    kbd.textContent = PRETTY[k] || k;
    return kbd;
  }));
}

keysBtn.addEventListener('click', () => { recording = !recording; renderKeys(); });
keysBtn.addEventListener('blur', () => { recording = false; renderKeys(); });
keysBtn.addEventListener('keydown', (e) => {
  if (!recording) return;
  e.preventDefault();
  if (e.key === 'Escape') { recording = false; renderKeys(); return; }
  const combo = shortcutFrom(e);
  if (combo) { hotkey = combo; recording = false; renderKeys(); }
});

// ---------------------------------------------------------------- quick links
function linkRow(name = '', target = '') {
  const row = document.createElement('div');
  row.className = 'row link';
  const alias = Object.assign(document.createElement('input'), { className: 'alias', value: name, placeholder: 'name', spellcheck: false });
  const arrow = Object.assign(document.createElement('span'), { className: 'arrow', textContent: '→' });
  const tgt = Object.assign(document.createElement('input'), { className: 'target', value: target, placeholder: 'https://… or an app or folder', spellcheck: false });
  const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'remove', textContent: '×', title: 'Remove' });
  remove.addEventListener('click', () => { row.remove(); emptyState(); });
  row.append(alias, arrow, tgt, remove);
  return row;
}

function emptyState() {
  if (!links.querySelector('.link')) links.innerHTML = '<div class="empty">No links yet.</div>';
}

$('add-link').addEventListener('click', () => {
  links.querySelector('.empty')?.remove();
  const row = linkRow();
  links.append(row);
  row.querySelector('.alias').focus();
});

function readLinks() {
  const aliases = {};
  for (const row of links.querySelectorAll('.link')) {
    const name = row.querySelector('.alias').value.trim();
    const target = row.querySelector('.target').value.trim();
    if (name && target) aliases[name] = target;
  }
  return aliases;
}

// ---------------------------------------------------------------- load / save
async function load() {
  const s = await invoke('get_state');
  platform = s.platform;
  hotkey = s.config.hotkey || hotkey;
  renderKeys();
  links.replaceChildren(...Object.entries(s.config.aliases || {}).map(([k, v]) => linkRow(k, v)));
  emptyState();
  $('ollama_url').value = s.config.ollama_url || '';
  $('ollama_model').value = s.config.ollama_model || '';
  $('autostart').checked = !!s.autostart;
  $('version').textContent = `v${s.version}`;
}

async function save() {
  if (saving) return;
  saving = true;
  statusEl.textContent = '';
  try {
    const current = (await invoke('get_state')).config;
    await invoke('save_settings', {
      config: {
        ...current,
        hotkey,
        aliases: readLinks(),
        ollama_url: $('ollama_url').value.trim() || 'http://localhost:11434',
        ollama_model: $('ollama_model').value.trim() || 'llama3.1',
      },
      autostart: $('autostart').checked,
    });
    await invoke('close_settings');
  } catch (err) {
    statusEl.textContent = String(err);
  } finally {
    saving = false;
  }
}

$('save').addEventListener('click', save);
$('quit').addEventListener('click', () => invoke('quit'));
$('data').addEventListener('click', () => invoke('open_folder', { kind: 'data' }));
$('ollama-link').addEventListener('click', (e) => { e.preventDefault(); invoke('open_url', { url: 'https://ollama.com' }); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) save(); });
listen('settings:request-save', save); // the window's close button

load();
