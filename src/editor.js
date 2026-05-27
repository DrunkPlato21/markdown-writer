import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import BubbleMenu from '@tiptap/extension-bubble-menu';
import { Markdown } from 'tiptap-markdown';
import { Search } from './search.js';
import { CollapsibleHeadings } from './collapse.js';
import { FocusMode } from './focus.js';
import { Typography } from './typography.js';
import './styles.css';

// ---- Tabs state ----
let tabs = []; // { id, filePath, filename, content, cursorPos, dirty }
let activeTabId = null;
let tabIdCounter = 0;
let saveTimeout = null;
let draftTimeout = null;
let copyTabTimeout = null;

// ---- DOM refs ----
const bubbleMenuEl = document.querySelector('.bubble-menu');
// title-filename removed from DOM; window title set via API
const saveIndicatorEl = document.querySelector('.save-indicator');
const wordCountEl = document.getElementById('wc');
const dropOverlay = document.querySelector('.drop-overlay');
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const replaceInput = document.getElementById('replace-input');
const findCount = document.getElementById('find-count');
const replaceRow = document.getElementById('replace-row');
const focusBtn = document.getElementById('btn-focus');
const typewriterBtn = document.getElementById('btn-typewriter');
const outlineBtn = document.getElementById('btn-outline');
const readBtn = document.getElementById('btn-read');
const outlineListEl = document.getElementById('outline-list');
const editorWrap = document.querySelector('.editor-wrap');
const tabBar = document.getElementById('tab-bar');

// ---- Settings ----
let fontIndex = 0;
let documentsPath = null;
let cursorByPath = {};
let typewriterMode = false;
let outlineVisible = false;
let readMode = false;

(async () => {
  const settings = window.api?.getSettings ? await window.api.getSettings() : {};
  fontIndex = settings.fontIndex ?? 0;
  cursorByPath = settings.cursorByPath || {};
  applyFont(fontIndex);
  if (settings.outlineVisible) setOutlineVisible(true);
  if (window.api?.getDocumentsPath) {
    documentsPath = await window.api.getDocumentsPath();
  }
})();

// ---- Fonts ----
const fonts = [
  { name: 'Cormorant Garamond', family: "'Cormorant Garamond', Georgia, serif", size: '20px', lineHeight: '1.5' },
  { name: 'Lora',               family: "'Lora', Georgia, serif",               size: '19px', lineHeight: '1.6' },
  { name: 'Newsreader',         family: "'Newsreader', Georgia, serif",         size: '20px', lineHeight: '1.55' },
  { name: 'Literata',           family: "'Literata', Georgia, serif",           size: '19px', lineHeight: '1.6' },
  { name: 'Spectral',           family: "'Spectral', Georgia, serif",           size: '19px', lineHeight: '1.65' },
];

function applyFont(index) {
  const font = fonts[index];
  // --font-serif drives the editor body. The header uses
  // --font-header (set once in :root) so the chrome stays
  // anchored while the user cycles writing fonts.
  document.documentElement.style.setProperty('--font-serif', font.family);
  const pm = document.querySelector('.ProseMirror');
  if (pm) {
    pm.style.setProperty('font-size', font.size);
    pm.style.setProperty('line-height', font.lineHeight);
  }
  const btn = document.getElementById('btn-font');
  if (btn) btn.title = `${font.name} — cycle font (Ctrl+/)`;
  const label = document.getElementById('font-label');
  if (label) label.textContent = font.name;
}

// Seed hidden copies of every font name into the picker so the button
// reserves the widest possible width upfront. Visible label stacks on
// top of the ghosts via grid-area: 1/1 (see styles.css).
function buildFontLabelGhosts() {
  const stack = document.querySelector('.titlebar-font .font-label-stack');
  if (!stack) return;
  for (const font of fonts) {
    const ghost = document.createElement('span');
    ghost.className = 'font-label-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.textContent = font.name;
    stack.appendChild(ghost);
  }
}
buildFontLabelGhosts();

function cycleFont() {
  fontIndex = (fontIndex + 1) % fonts.length;
  applyFont(fontIndex);
  saveSettings({ fontIndex });
}

// ---- Editor ----
const editor = new Editor({
  element: document.querySelector('#editor'),
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
    }),
    Markdown.configure({
      html: false,
      transformCopiedText: false,
      transformPastedText: true,
    }),
    Placeholder.configure({
      placeholder: 'Start writing...',
    }),
    Link.configure({
      openOnClick: false,
      HTMLAttributes: { rel: 'noopener noreferrer' },
    }),
    BubbleMenu.configure({
      element: bubbleMenuEl,
      shouldShow: ({ state }) => !state.selection.empty,
      tippyOptions: { duration: [150, 100], placement: 'top' },
    }),
    Search,
    CollapsibleHeadings,
    FocusMode,
    Typography,
  ],
  autofocus: true,
  onUpdate: () => {
    const tab = getActiveTab();
    if (tab && !suppressDirty) {
      tab.dirty = true;
      scheduleAutosave();
      scheduleDraftSave();
      if (!tab.filePath) autoNameTab(tab);
    }
    updateWordCount();
    renderTabs();
    if (typewriterMode) applyTypewriterScroll();
    if (outlineVisible) refreshOutline();
  },
  onSelectionUpdate: () => {
    updateBubbleMenuState();
    if (typewriterMode) applyTypewriterScroll();
    if (outlineVisible) updateOutlineActive();
  },
});

// ---- Typewriter mode ----

function applyTypewriterScroll() {
  const pos = editor.state.selection.head;
  let coords;
  try { coords = editor.view.coordsAtPos(pos); } catch { return; }
  const wrap = document.querySelector('.editor-wrap');
  if (!wrap) return;
  const target = window.innerHeight * 0.42;
  const delta = coords.top - target;
  if (Math.abs(delta) > 1) wrap.scrollTop += delta;
}

function toggleTypewriterMode() {
  typewriterMode = !typewriterMode;
  document.body.classList.toggle('typewriter-mode', typewriterMode);
  typewriterBtn?.classList.toggle('active', typewriterMode);
  if (typewriterMode) applyTypewriterScroll();
}

// ---- Outline sidebar ----

let outlineHeadings = [];

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function collectHeadings() {
  const items = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const text = node.textContent.trim();
      if (text) items.push({ pos, level: node.attrs.level, text });
      return false; // don't descend into heading
    }
    return true;
  });
  return items;
}

function refreshOutline() {
  if (!outlineListEl) return;
  outlineHeadings = collectHeadings();
  if (outlineHeadings.length === 0) {
    outlineListEl.innerHTML = '<div class="outline-empty">No headings yet</div>';
    return;
  }
  outlineListEl.innerHTML = outlineHeadings
    .map((h, i) =>
      `<div class="outline-item outline-h${h.level}" data-pos="${h.pos}" data-idx="${i}" title="${escapeHtml(h.text)}">${escapeHtml(h.text)}</div>`
    )
    .join('');
  outlineListEl.querySelectorAll('.outline-item').forEach((el) => {
    el.addEventListener('click', () => {
      const pos = parseInt(el.dataset.pos);
      jumpToHeading(pos);
    });
  });
  updateOutlineActive();
}

function jumpToHeading(pos) {
  const target = pos + 1; // inside the heading
  editor.commands.focus();
  editor.commands.setTextSelection(Math.min(target, editor.state.doc.content.size));
  const dom = editor.view.domAtPos(target);
  if (dom?.node) {
    const el = dom.node.nodeType === 3 ? dom.node.parentElement : dom.node;
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function updateOutlineActive() {
  if (!outlineVisible || !outlineListEl || outlineHeadings.length === 0) return;
  const caret = editor.state.selection.head;
  // Pick the last heading whose position is <= caret
  let activeIdx = -1;
  for (let i = 0; i < outlineHeadings.length; i++) {
    if (outlineHeadings[i].pos <= caret) activeIdx = i;
    else break;
  }
  outlineListEl.querySelectorAll('.outline-item').forEach((el, i) => {
    el.classList.toggle('active', i === activeIdx);
  });
}

function setOutlineVisible(visible) {
  outlineVisible = visible;
  document.body.classList.toggle('outline-visible', visible);
  outlineBtn?.classList.toggle('active', visible);
  if (visible) refreshOutline();
}

function toggleOutline() {
  setOutlineVisible(!outlineVisible);
  saveSettings({ outlineVisible });
}

// ---- Read mode ----

function setReadMode(active) {
  readMode = active;
  document.body.classList.toggle('read-mode', active);
  readBtn?.classList.toggle('active', active);
  editor.setEditable(!active);
  window.api?.setFullscreen?.(active);
  if (!active) editor.commands.focus();
}

function toggleReadMode() {
  setReadMode(!readMode);
}

// ---- Tab management ----

function createTab(filePath, content) {
  const id = ++tabIdCounter;
  const filename = filePath
    ? filePath.replace(/\\/g, '/').split('/').pop()
    : 'Untitled';
  const tab = { id, filePath, filename, content: content || '', cursorPos: 0, dirty: false, namedByUser: !!filePath };
  tabs.push(tab);
  return tab;
}

function autoNameTab(tab) {
  if (tab.namedByUser) return;
  const text = editor.state.doc.textContent.trim();
  if (!text) { tab.filename = 'Untitled'; return; }
  // Grab first line, strip markdown/punctuation cruft
  const firstLine = text.split(/\n/)[0].replace(/^#+\s*/, '').replace(/[*_~`]/g, '').trim();
  if (!firstLine) { tab.filename = 'Untitled'; return; }
  // Take first 1-3 meaningful words
  const words = firstLine.split(/\s+/).filter((w) => w.length > 0).slice(0, 3);
  const slug = words.join('-').replace(/[^a-zA-Z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  const newName = (slug || 'untitled') + '.md';
  tab.filename = newName;
  window.api?.setTitle?.(newName);

  // Auto-assign a file path in Documents/markdown-writer so autosave works
  if (!tab.filePath && slug && documentsPath) {
    const dir = documentsPath + '/markdown-writer';
    window.api?.ensureDir?.(dir);
    tab.filePath = dir + '/' + newName;
  }
}

function getActiveTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

let suppressDirty = false;

function switchToTab(id) {
  if (id === activeTabId) return;

  // Save current tab state
  const current = getActiveTab();
  if (current) {
    current.content = editor.storage.markdown.getMarkdown();
    current.cursorPos = editor.state.selection.from;
    persistCursor(current);
  }

  activeTabId = id;
  const tab = getActiveTab();
  if (!tab) return;

  suppressDirty = true;
  editor.commands.setContent(tab.content);
  suppressDirty = false;
  const maxPos = editor.state.doc.content.size;
  const pos = Math.min(tab.cursorPos || 0, maxPos);
  editor.commands.setTextSelection(pos);

  window.api?.setTitle?.(tab.filename);
  updateWordCount();
  renderTabs();
  if (outlineVisible) refreshOutline();
  editor.commands.focus();
  if (tab.filePath) saveSettings({ lastFile: tab.filePath });
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;

  const tab = tabs[idx];

  // Autosave before closing if dirty and has a file
  if (tab.dirty && tab.filePath) {
    // Save synchronously-ish
    if (tab.id === activeTabId) {
      tab.content = editor.storage.markdown.getMarkdown();
      tab.cursorPos = editor.state.selection.from;
    }
    window.api?.writeFile?.(tab.filePath, tab.content);
  }
  if (tab.id === activeTabId) tab.cursorPos = editor.state.selection.from;
  persistCursor(tab);

  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    // Create a fresh untitled tab
    const fresh = createTab(null, '');
    switchToTab(fresh.id);
  } else if (id === activeTabId) {
    // Switch to nearest tab
    const newIdx = Math.min(idx, tabs.length - 1);
    switchToTab(tabs[newIdx].id);
  }

  renderTabs();
}

function renderTabs() {
  tabBar.innerHTML = tabs
    .map((tab) => {
      const activeClass = tab.id === activeTabId ? ' active' : '';
      const dirtyClass = tab.dirty ? ' dirty' : '';
      return `<div class="tab${activeClass}${dirtyClass}" data-tab-id="${tab.id}">
        <span class="tab-name">${tab.filename}</span>
        <button class="tab-close" data-close-id="${tab.id}">&times;</button>
      </div>`;
    })
    .join('') + '<button class="tab-new" id="tab-new-btn" title="New tab (Ctrl+N)">+</button>';

  // Click handlers
  tabBar.querySelectorAll('.tab').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      const tabId = parseInt(el.dataset.tabId);
      if (tabId === activeTabId) {
        // Defer copy so a double-click (rename) can cancel it
        clearTimeout(copyTabTimeout);
        copyTabTimeout = setTimeout(() => {
          copyTabTimeout = null;
          copyTabPath(tabId);
        }, 220);
      } else {
        switchToTab(tabId);
      }
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const tabId = parseInt(el.dataset.tabId);
      showTabMenu(tabId, e.clientX, e.clientY);
    });

    // Double-click to rename
    const nameEl = el.querySelector('.tab-name');
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      clearTimeout(copyTabTimeout);
      copyTabTimeout = null;
      const tabId = parseInt(el.dataset.tabId);
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tab-rename';
      input.value = tab.filename;
      // Select just the name, not the extension
      const dotIdx = tab.filename.lastIndexOf('.');
      nameEl.replaceWith(input);
      input.focus();
      input.setSelectionRange(0, dotIdx > 0 ? dotIdx : tab.filename.length);

      function commitRename() {
        const newName = input.value.trim();
        if (!newName || newName === tab.filename) {
          renderTabs();
          return;
        }
        tab.filename = newName;
        tab.namedByUser = true;
        if (tab.filePath) {
          // Rename existing file on disk
          const dir = tab.filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
          const newPath = dir + '/' + newName;
          window.api?.renameFile?.(tab.filePath, newPath).then((ok) => {
            if (ok) {
              tab.filePath = newPath;
              window.api?.setTitle?.(newName);
              saveSettings({ lastFile: newPath });
            }
            renderTabs();
          }).catch(() => renderTabs());
        } else if (documentsPath) {
          // New file -- assign path in Documents/markdown-writer so autosave works
          const safeName = newName.endsWith('.md') ? newName : newName + '.md';
          const dir = documentsPath + '/markdown-writer';
          window.api?.ensureDir?.(dir);
          tab.filename = safeName;
          tab.filePath = dir + '/' + safeName;
          tab.dirty = true;
          window.api?.setTitle?.(safeName);
          doSave();
          renderTabs();
        } else {
          renderTabs();
        }
      }

      input.addEventListener('blur', commitRename);
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
        if (ke.key === 'Escape') { ke.preventDefault(); renderTabs(); }
      });
    });
  });
  tabBar.querySelectorAll('.tab-close').forEach((el) => {
    el.addEventListener('click', () => {
      closeTab(parseInt(el.dataset.closeId));
    });
  });
  document.getElementById('tab-new-btn')?.addEventListener('click', newFile);

  // Keep the active tab visible when the tab bar overflows (narrow window
  // or many tabs). Without this, shrinking the window can hide the tab
  // you're currently editing.
  const activeEl = tabBar.querySelector('.tab.active');
  activeEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---- Autosave ----

function scheduleAutosave() {
  const tab = getActiveTab();
  if (!tab?.filePath) return;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(doSave, 1500);
}

async function doSave() {
  const tab = getActiveTab();
  if (!tab?.filePath || !tab.dirty) return;
  try {
    const markdown = editor.storage.markdown.getMarkdown();
    await window.api.writeFile(tab.filePath, markdown);
    tab.dirty = false;
    showSaved();
    renderTabs();
  } catch (err) {
    console.error('Save failed:', err);
  }
}

function showSaved() {
  saveIndicatorEl.textContent = 'saved';
  saveIndicatorEl.classList.add('show');
  setTimeout(() => saveIndicatorEl.classList.remove('show'), 2000);
}

function showStatus(text, duration = 1500) {
  saveIndicatorEl.textContent = text;
  saveIndicatorEl.classList.add('show');
  setTimeout(() => {
    saveIndicatorEl.classList.remove('show');
    setTimeout(() => { saveIndicatorEl.textContent = 'saved'; }, 400);
  }, duration);
}

function showTabMenu(tabId, x, y) {
  document.querySelectorAll('.tab-menu').forEach((m) => m.remove());
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const menu = document.createElement('div');
  menu.className = 'tab-menu';
  const items = [];
  if (tab.filePath) {
    items.push({ label: 'Reveal in Explorer', action: () => window.api?.showInFolder?.(tab.filePath) });
    items.push({ label: 'Copy full path', action: () => copyTabPath(tabId) });
    items.push({ sep: true });
  }
  items.push({ label: 'Rename…', action: () => beginRename(tabId) });
  items.push({ sep: true });
  items.push({ label: 'Close', action: () => closeTab(tabId) });
  if (tabs.length > 1) {
    items.push({ label: 'Close others', action: () => {
      tabs.filter((t) => t.id !== tabId).slice().forEach((t) => closeTab(t.id));
    } });
  }

  items.forEach((item) => {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'tab-menu-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'tab-menu-item';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      item.action();
      menu.remove();
    });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  // Position, clamping to viewport
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  const dismiss = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', escDismiss, true);
    }
  };
  const escDismiss = (ev) => {
    if (ev.key === 'Escape') {
      menu.remove();
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', escDismiss, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', escDismiss, true);
  }, 0);
}

function beginRename(tabId) {
  const tabEl = tabBar.querySelector(`.tab[data-tab-id="${tabId}"] .tab-name`);
  if (tabEl) {
    const evt = new MouseEvent('dblclick', { bubbles: true });
    tabEl.dispatchEvent(evt);
  }
}

async function copyTabPath(tabId) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (!tab.filePath) {
    showStatus('no path yet');
    return;
  }
  const path = tab.filePath.replace(/\//g, '\\');
  try {
    await navigator.clipboard.writeText(path);
    showStatus('path copied');
  } catch {
    showStatus('copy failed');
  }
}

// ---- Draft persistence (crash recovery) ----

function scheduleDraftSave() {
  if (!window.api?.saveDraft) return;
  clearTimeout(draftTimeout);
  draftTimeout = setTimeout(() => {
    const markdown = editor.storage.markdown.getMarkdown();
    const cursorPos = editor.state.selection.from;
    const tab = getActiveTab();
    window.api.saveDraft(markdown, tab?.filePath || null, cursorPos);
  }, 3000);
}

async function restoreDraft() {
  if (!window.api?.loadDraft) return;
  const draft = await window.api.loadDraft();
  if (!draft || !draft.content) return;

  if (draft.filePath) {
    try {
      await openFile(draft.filePath);
      const maxPos = editor.state.doc.content.size;
      const pos = Math.min(draft.cursorPos || 0, maxPos);
      editor.commands.setTextSelection(pos);
      const dom = editor.view.domAtPos(pos);
      if (dom?.node) {
        const el = dom.node.nodeType === 3 ? dom.node.parentElement : dom.node;
        el?.scrollIntoView({ block: 'center' });
      }
      return;
    } catch {}
  }

  if (draft.content.trim()) {
    const tab = getActiveTab();
    if (tab) {
      tab.content = draft.content;
      editor.commands.setContent(draft.content);
      const maxPos = editor.state.doc.content.size;
      const pos = Math.min(draft.cursorPos || 0, maxPos);
      editor.commands.setTextSelection(pos);
      updateWordCount();
    }
  }
}

// ---- Word count ----

function updateWordCount() {
  const text = editor.state.doc.textContent;
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const chars = text.length;
  const sentences = trimmed ? (trimmed.match(/[.!?]+(?:\s|$)/g) || []).length || 1 : 0;
  const minutes = Math.max(1, Math.round(words / 220));
  const wordLabel = `${words.toLocaleString()} word${words !== 1 ? 's' : ''}`;
  const minLabel = words > 0 ? ` · ${minutes} min` : '';
  wordCountEl.textContent = wordLabel + minLabel;
  const avgSent = sentences > 0 ? Math.round(words / sentences) : 0;
  wordCountEl.title = `${words.toLocaleString()} words\n${chars.toLocaleString()} characters\n${sentences.toLocaleString()} sentence${sentences !== 1 ? 's' : ''}${avgSent ? ` (avg ${avgSent} words)` : ''}\n~${minutes} min read`;
}

// ---- File operations ----

async function openFile(filePath) {
  // Check if already open in a tab
  const existing = tabs.find((t) => t.filePath === filePath);
  if (existing) {
    switchToTab(existing.id);
    return;
  }

  try {
    const content = await window.api.readFile(filePath);
    const tab = createTab(filePath, content);
    if (typeof cursorByPath[filePath] === 'number') {
      tab.cursorPos = cursorByPath[filePath];
    }

    // If the current tab is untitled and empty, replace it
    const current = getActiveTab();
    if (current && !current.filePath && !current.dirty && !editor.state.doc.textContent.trim()) {
      const idx = tabs.findIndex((t) => t.id === current.id);
      if (idx !== -1) tabs.splice(idx, 1);
    }

    switchToTab(tab.id);
    saveSettings({ lastFile: filePath });
    scrollCursorIntoView();
  } catch (err) {
    console.error('Failed to open file:', err);
  }
}

function scrollCursorIntoView() {
  const pos = editor.state.selection.from;
  const dom = editor.view.domAtPos(pos);
  if (dom?.node) {
    const el = dom.node.nodeType === 3 ? dom.node.parentElement : dom.node;
    el?.scrollIntoView({ block: 'center' });
  }
}

function persistCursor(tab) {
  if (!tab?.filePath) return;
  cursorByPath[tab.filePath] = tab.cursorPos || 0;
  saveSettings({ cursorByPath });
}

async function openFileDialog() {
  const filePath = await window.api.openFileDialog();
  if (filePath) await openFile(filePath);
}

async function saveAs() {
  const filePath = await window.api.saveFileDialog();
  if (!filePath) return;
  const tab = getActiveTab();
  if (tab) {
    tab.filePath = filePath;
    tab.filename = filePath.replace(/\\/g, '/').split('/').pop();
    tab.namedByUser = true;
    tab.dirty = true;
    tab.content = editor.storage.markdown.getMarkdown();
    window.api?.setTitle?.(tab.filename);
    await doSave();
    renderTabs();
    saveSettings({ lastFile: filePath });
  }
}

async function newFile() {
  const tab = createTab(null, '');
  switchToTab(tab.id);
}

// ---- Settings persistence ----

function saveSettings(data) {
  window.api?.saveSettings?.(data);
}

// ---- Bubble menu ----

function updateBubbleMenuState() {
  bubbleMenuEl.querySelectorAll('button[data-action]').forEach((btn) => {
    const action = btn.dataset.action;
    let active = false;
    switch (action) {
      case 'bold':       active = editor.isActive('bold'); break;
      case 'italic':     active = editor.isActive('italic'); break;
      case 'strike':     active = editor.isActive('strike'); break;
      case 'heading1':   active = editor.isActive('heading', { level: 1 }); break;
      case 'heading2':   active = editor.isActive('heading', { level: 2 }); break;
      case 'heading3':   active = editor.isActive('heading', { level: 3 }); break;
      case 'blockquote': active = editor.isActive('blockquote'); break;
      case 'bulletList': active = editor.isActive('bulletList'); break;
    }
    btn.classList.toggle('is-active', active);
  });
}

bubbleMenuEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  e.preventDefault();
  if (btn.dataset.action === 'link') {
    openLinkDialog();
    return;
  }
  const chain = editor.chain().focus();
  switch (btn.dataset.action) {
    case 'bold':       chain.toggleBold().run(); break;
    case 'italic':     chain.toggleItalic().run(); break;
    case 'strike':     chain.toggleStrike().run(); break;
    case 'heading1':   chain.toggleHeading({ level: 1 }).run(); break;
    case 'heading2':   chain.toggleHeading({ level: 2 }).run(); break;
    case 'heading3':   chain.toggleHeading({ level: 3 }).run(); break;
    case 'blockquote': chain.toggleBlockquote().run(); break;
    case 'bulletList': chain.toggleBulletList().run(); break;
  }
});

// ---- Link dialog ----

const linkDialog = document.getElementById('link-dialog');
const linkUrlInput = document.getElementById('link-url');
const linkApplyBtn = document.getElementById('link-apply');
const linkCancelBtn = document.getElementById('link-cancel');
const linkRemoveBtn = document.getElementById('link-remove');

function normalizeUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^(https?:|mailto:|ftp:|tel:|#|\/)/i.test(trimmed)) return trimmed;
  if (/^[\w.-]+@[\w.-]+\.\w+$/.test(trimmed)) return 'mailto:' + trimmed;
  return 'https://' + trimmed;
}

function openLinkDialog() {
  // If the selection is empty, expand to the surrounding link mark (so user can edit)
  if (editor.state.selection.empty && editor.isActive('link')) {
    editor.chain().focus().extendMarkRange('link').run();
  }
  const existing = editor.getAttributes('link').href || '';
  linkUrlInput.value = existing;
  linkRemoveBtn.style.display = existing ? '' : 'none';
  linkDialog.classList.add('open');
  setTimeout(() => {
    linkUrlInput.focus();
    linkUrlInput.select();
  }, 0);
}

function closeLinkDialog() {
  linkDialog.classList.remove('open');
  editor.commands.focus();
}

function applyLink() {
  const url = normalizeUrl(linkUrlInput.value);
  if (!url) {
    closeLinkDialog();
    return;
  }
  const chain = editor.chain().focus().extendMarkRange('link');
  if (editor.state.selection.empty && !editor.isActive('link')) {
    // No selection and no existing link — insert the URL text and link it
    chain.insertContent({
      type: 'text',
      text: linkUrlInput.value.trim(),
      marks: [{ type: 'link', attrs: { href: url } }],
    }).run();
  } else {
    chain.setLink({ href: url }).run();
  }
  closeLinkDialog();
}

function removeLink() {
  editor.chain().focus().extendMarkRange('link').unsetLink().run();
  closeLinkDialog();
}

linkApplyBtn.addEventListener('click', applyLink);
linkCancelBtn.addEventListener('click', closeLinkDialog);
linkRemoveBtn.addEventListener('click', removeLink);
linkUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
  if (e.key === 'Escape') { e.preventDefault(); closeLinkDialog(); }
});
linkDialog.addEventListener('click', (e) => {
  if (e.target === linkDialog) closeLinkDialog();
});

// Ctrl/Cmd-click an existing link to open in default browser
document.querySelector('#editor').addEventListener('click', (e) => {
  const anchor = e.target.closest('a');
  if (anchor && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    const href = anchor.getAttribute('href');
    if (href) window.open(href, '_blank');
  }
});

// ---- Find / Replace ----

function openFind(withReplace = false) {
  findBar.classList.add('open');
  if (withReplace) replaceRow.classList.add('open');
  findInput.focus();
  findInput.select();
}

function closeFind() {
  findBar.classList.remove('open');
  replaceRow.classList.remove('open');
  editor.storage.search.term = '';
  editor.storage.search.currentIndex = -1;
  editor.view.dispatch(editor.state.tr);
  findCount.textContent = '';
  editor.commands.focus();
}

function updateSearch() {
  const term = findInput.value;
  editor.storage.search.term = term;
  editor.storage.search.replaceTerm = replaceInput.value;
  if (!term) {
    editor.storage.search.currentIndex = -1;
  } else if (editor.storage.search.currentIndex === -1) {
    editor.storage.search.currentIndex = 0;
  }
  editor.view.dispatch(editor.state.tr);
  updateFindCount();
  scrollToCurrentMatch();
}

function updateFindCount() {
  const { results, currentIndex } = editor.storage.search;
  if (!results.length) {
    findCount.textContent = editor.storage.search.term ? 'No results' : '';
  } else {
    findCount.textContent = `${currentIndex + 1} / ${results.length}`;
  }
}

function scrollToCurrentMatch() {
  const { results, currentIndex } = editor.storage.search;
  if (currentIndex >= 0 && currentIndex < results.length) {
    const match = results[currentIndex];
    editor.commands.setTextSelection(match.from);
    const dom = editor.view.domAtPos(match.from);
    if (dom?.node) {
      const el = dom.node.nodeType === 3 ? dom.node.parentElement : dom.node;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

function nextMatch() {
  const { results, currentIndex } = editor.storage.search;
  if (!results.length) return;
  editor.storage.search.currentIndex = (currentIndex + 1) % results.length;
  editor.view.dispatch(editor.state.tr);
  updateFindCount();
  scrollToCurrentMatch();
}

function prevMatch() {
  const { results, currentIndex } = editor.storage.search;
  if (!results.length) return;
  editor.storage.search.currentIndex = (currentIndex - 1 + results.length) % results.length;
  editor.view.dispatch(editor.state.tr);
  updateFindCount();
  scrollToCurrentMatch();
}

function replaceCurrent() {
  const { results, currentIndex } = editor.storage.search;
  if (currentIndex < 0 || currentIndex >= results.length) return;
  const { from, to } = results[currentIndex];
  const replaceTerm = replaceInput.value || '';
  const { tr } = editor.state;
  tr.insertText(replaceTerm, from, to);
  editor.view.dispatch(tr);
  setTimeout(updateSearch, 50);
}

function replaceAllMatches() {
  const { results } = editor.storage.search;
  if (!results.length) return;
  const replaceTerm = replaceInput.value || '';
  const { tr } = editor.state;
  [...results].sort((a, b) => b.from - a.from).forEach(({ from, to }) => {
    tr.insertText(replaceTerm, from, to);
  });
  editor.view.dispatch(tr);
  setTimeout(updateSearch, 50);
}

findInput.addEventListener('input', updateSearch);
replaceInput.addEventListener('input', () => {
  editor.storage.search.replaceTerm = replaceInput.value;
});

document.getElementById('find-next').addEventListener('click', nextMatch);
document.getElementById('find-prev').addEventListener('click', prevMatch);
document.getElementById('find-close').addEventListener('click', closeFind);
document.getElementById('find-toggle-replace').addEventListener('click', () => {
  replaceRow.classList.toggle('open');
});
document.getElementById('replace-one').addEventListener('click', replaceCurrent);
document.getElementById('replace-all').addEventListener('click', replaceAllMatches);

findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    prevMatch();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    nextMatch();
  } else if (e.key === 'Escape') {
    closeFind();
  }
});

replaceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeFind();
  if (e.key === 'Enter') {
    e.preventDefault();
    replaceCurrent();
  }
});

// ---- Focus mode ----

function toggleFocusMode() {
  const active = !editor.storage.focusMode.active;
  editor.storage.focusMode.active = active;
  document.body.classList.toggle('focus-mode', active);
  focusBtn.classList.toggle('active', active);
  editor.view.dispatch(editor.state.tr);
}

// ---- Drag and drop ----

let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) dropOverlay.classList.add('active');
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) dropOverlay.classList.remove('active');
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('active');
  const file = e.dataTransfer?.files?.[0];
  if (file && /\.(md|markdown|txt)$/i.test(file.name)) {
    if (file.path) await openFile(file.path);
  }
});

// ---- Keyboard shortcuts ----

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
    // Keep Ctrl+A scoped to the article body. Without this, when focus is
    // outside the editor (toolbar button, tab, body), the browser default
    // selects every selectable string in the chrome too.
    const tag = e.target?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      editor.commands.focus();
      editor.commands.selectAll();
      return;
    }
  }
  if (e.ctrlKey && e.key === 'o') {
    e.preventDefault();
    openFileDialog();
  }
  if (e.ctrlKey && e.key === 'n') {
    e.preventDefault();
    newFile();
  }
  if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
    e.preventDefault();
    saveAs();
    return;
  }
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    const tab = getActiveTab();
    if (!tab?.filePath) saveAs();
    else if (tab.dirty) doSave();
    else showSaved();
  }
  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
  }
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    if (tabs.length > 1) {
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      const next = e.shiftKey
        ? (idx - 1 + tabs.length) % tabs.length
        : (idx + 1) % tabs.length;
      switchToTab(tabs[next].id);
    }
  }
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    openFind(false);
  }
  if (e.ctrlKey && e.key === 'h') {
    e.preventDefault();
    openFind(true);
  }
  if (e.ctrlKey && e.key === '/') {
    e.preventDefault();
    cycleFont();
  }
  if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    openLinkDialog();
  }
  if (e.key === 'F11') {
    e.preventDefault();
    toggleReadMode();
  }
  if (e.key === 'F7') {
    e.preventDefault();
    toggleOutline();
  }
  if (e.key === 'F8') {
    e.preventDefault();
    toggleFocusMode();
  }
  if (e.key === 'F9') {
    e.preventDefault();
    toggleTypewriterMode();
  }
  if (e.key === 'Escape' && readMode) {
    e.preventDefault();
    setReadMode(false);
  }
});

// ---- Title bar buttons ----

document.getElementById('btn-open').addEventListener('click', openFileDialog);
document.getElementById('btn-save-as')?.addEventListener('click', saveAs);
document.getElementById('btn-new')?.addEventListener('click', newFile);
document.getElementById('btn-font').addEventListener('click', cycleFont);
focusBtn.addEventListener('click', toggleFocusMode);
typewriterBtn?.addEventListener('click', toggleTypewriterMode);
outlineBtn?.addEventListener('click', toggleOutline);
readBtn?.addEventListener('click', toggleReadMode);

// ---- View dropdown ----
// Houses the four mode toggles (Outline/Focus/Typewriter/Read) so they
// don't crowd the tab bar. Positioned with fixed coords so it isn't
// clipped by the titlebar's overflow.

const viewBtn = document.getElementById('btn-view');
const viewDropdown = document.getElementById('view-dropdown');
let viewDropdownDetach = null;

function positionViewDropdown() {
  if (!viewBtn || !viewDropdown) return;
  const rect = viewBtn.getBoundingClientRect();
  viewDropdown.style.top = (rect.bottom + 6) + 'px';
  viewDropdown.style.right = (window.innerWidth - rect.right) + 'px';
}

function openViewDropdown() {
  if (!viewBtn || !viewDropdown || !viewDropdown.hidden) return;
  viewDropdown.hidden = false;
  viewBtn.setAttribute('aria-expanded', 'true');
  positionViewDropdown();

  const onDocDown = (ev) => {
    if (viewDropdown.contains(ev.target) || viewBtn.contains(ev.target)) return;
    closeViewDropdown();
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeViewDropdown();
      viewBtn.focus();
    }
  };
  const onResize = () => positionViewDropdown();

  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  viewDropdownDetach = () => {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
  };
}

function closeViewDropdown() {
  if (!viewDropdown || viewDropdown.hidden) return;
  viewDropdown.hidden = true;
  viewBtn?.setAttribute('aria-expanded', 'false');
  if (viewDropdownDetach) {
    viewDropdownDetach();
    viewDropdownDetach = null;
  }
}

viewBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (viewDropdown.hidden) openViewDropdown();
  else closeViewDropdown();
});

// Toggles inside the dropdown each manage their own active state via
// existing handlers above; close the menu after a selection so the
// chrome doesn't linger over the document.
[outlineBtn, focusBtn, typewriterBtn, readBtn].forEach((btn) => {
  btn?.addEventListener('click', closeViewDropdown);
});

// ---- Receive file from main process ----

let fileOpenedFromMain = false;

if (window.api?.onOpenFile) {
  window.api.onOpenFile((filePath) => {
    fileOpenedFromMain = true;
    openFile(filePath);
  });
}

// ---- Init ----

// Create initial untitled tab — always start blank
const initialTab = createTab(null, '');
activeTabId = initialTab.id;
applyFont(fontIndex);
updateWordCount();
renderTabs();

// Clear any stale draft so it can't reappear on next launch
window.api?.clearDraft?.();
