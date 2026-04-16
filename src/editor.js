import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import BubbleMenu from '@tiptap/extension-bubble-menu';
import { Markdown } from 'tiptap-markdown';
import { Search } from './search.js';
import { CollapsibleHeadings } from './collapse.js';
import { FocusMode } from './focus.js';
import './styles.css';

// ---- Tabs state ----
let tabs = []; // { id, filePath, filename, content, cursorPos, dirty }
let activeTabId = null;
let tabIdCounter = 0;
let saveTimeout = null;
let draftTimeout = null;

// ---- DOM refs ----
const bubbleMenuEl = document.querySelector('.bubble-menu');
const filenameEl = document.querySelector('.title-filename');
const saveIndicatorEl = document.querySelector('.save-indicator');
const wordCountEl = document.getElementById('wc');
const dropOverlay = document.querySelector('.drop-overlay');
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const replaceInput = document.getElementById('replace-input');
const findCount = document.getElementById('find-count');
const replaceRow = document.getElementById('replace-row');
const focusBtn = document.getElementById('btn-focus');
const tabBar = document.getElementById('tab-bar');

// ---- Settings ----
let fontIndex = 0;

(async () => {
  const settings = window.api?.getSettings ? await window.api.getSettings() : {};
  fontIndex = settings.fontIndex ?? 0;
  applyFont(fontIndex);
})();

// ---- Fonts ----
const fonts = [
  { name: 'Cormorant Garamond', family: "'Cormorant Garamond', Georgia, serif", size: '20px' },
  { name: 'Lora', family: "'Lora', Georgia, serif", size: '19px' },
  { name: 'Newsreader', family: "'Newsreader', Georgia, serif", size: '20px' },
  { name: 'Literata', family: "'Literata', Georgia, serif", size: '19px' },
  { name: 'Spectral', family: "'Spectral', Georgia, serif", size: '19px' },
];

function applyFont(index) {
  const font = fonts[index];
  document.documentElement.style.setProperty('--font-serif', font.family);
  document.querySelector('.ProseMirror')?.style?.setProperty('font-size', font.size);
  document.getElementById('font-label').textContent = font.name;
}

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
      transformCopiedText: true,
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
  ],
  autofocus: true,
  onUpdate: () => {
    const tab = getActiveTab();
    if (tab) tab.dirty = true;
    scheduleAutosave();
    scheduleDraftSave();
    updateWordCount();
    renderTabs();
  },
  onSelectionUpdate: () => {
    updateBubbleMenuState();
  },
});

// ---- Tab management ----

function createTab(filePath, content) {
  const id = ++tabIdCounter;
  const filename = filePath
    ? filePath.replace(/\\/g, '/').split('/').pop()
    : 'Untitled';
  const tab = { id, filePath, filename, content: content || '', cursorPos: 0, dirty: false };
  tabs.push(tab);
  return tab;
}

function getActiveTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

function switchToTab(id) {
  if (id === activeTabId) return;

  // Save current tab state
  const current = getActiveTab();
  if (current) {
    current.content = editor.storage.markdown.getMarkdown();
    current.cursorPos = editor.state.selection.from;
  }

  activeTabId = id;
  const tab = getActiveTab();
  if (!tab) return;

  editor.commands.setContent(tab.content);
  const maxPos = editor.state.doc.content.size;
  const pos = Math.min(tab.cursorPos || 0, maxPos);
  editor.commands.setTextSelection(pos);

  filenameEl.textContent = tab.filename;
  window.api?.setTitle?.(tab.filename);
  updateWordCount();
  renderTabs();
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
    }
    window.api?.writeFile?.(tab.filePath, tab.content);
  }

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
  // Only show tab bar when there are 2+ tabs
  if (tabs.length <= 1) {
    tabBar.innerHTML = '';
    return;
  }

  tabBar.innerHTML = tabs
    .map((tab) => {
      const activeClass = tab.id === activeTabId ? ' active' : '';
      const dirtyClass = tab.dirty ? ' dirty' : '';
      return `<div class="tab${activeClass}${dirtyClass}" data-tab-id="${tab.id}">
        <span class="tab-name">${tab.filename}</span>
        <button class="tab-close" data-close-id="${tab.id}">&times;</button>
      </div>`;
    })
    .join('');

  // Click handlers
  tabBar.querySelectorAll('.tab').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      switchToTab(parseInt(el.dataset.tabId));
    });
  });
  tabBar.querySelectorAll('.tab-close').forEach((el) => {
    el.addEventListener('click', () => {
      closeTab(parseInt(el.dataset.closeId));
    });
  });
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
  saveIndicatorEl.classList.add('show');
  setTimeout(() => saveIndicatorEl.classList.remove('show'), 2000);
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
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  wordCountEl.textContent = `${words.toLocaleString()} word${words !== 1 ? 's' : ''}`;
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

    // If the current tab is untitled and empty, replace it
    const current = getActiveTab();
    if (current && !current.filePath && !current.dirty && !editor.state.doc.textContent.trim()) {
      const idx = tabs.findIndex((t) => t.id === current.id);
      if (idx !== -1) tabs.splice(idx, 1);
    }

    switchToTab(tab.id);
    saveSettings({ lastFile: filePath });
  } catch (err) {
    console.error('Failed to open file:', err);
  }
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
    tab.dirty = true;
    tab.content = editor.storage.markdown.getMarkdown();
    filenameEl.textContent = tab.filename;
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
  if (e.ctrlKey && e.key === 'o') {
    e.preventDefault();
    openFileDialog();
  }
  if (e.ctrlKey && e.key === 'n') {
    e.preventDefault();
    newFile();
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
  if (e.key === 'F11') {
    e.preventDefault();
    window.api?.toggleFullscreen?.();
  }
  if (e.key === 'F8') {
    e.preventDefault();
    toggleFocusMode();
  }
});

// ---- Title bar buttons ----

document.getElementById('btn-open').addEventListener('click', openFileDialog);
document.getElementById('btn-new').addEventListener('click', newFile);
document.getElementById('btn-font').addEventListener('click', cycleFont);
focusBtn.addEventListener('click', toggleFocusMode);

// ---- Receive file from main process ----

let fileOpenedFromMain = false;

if (window.api?.onOpenFile) {
  window.api.onOpenFile((filePath) => {
    fileOpenedFromMain = true;
    openFile(filePath);
  });
}

// ---- Init ----

// Create initial untitled tab
const initialTab = createTab(null, '');
activeTabId = initialTab.id;
applyFont(fontIndex);
updateWordCount();
renderTabs();

// Restore draft after a short delay
setTimeout(() => {
  if (!fileOpenedFromMain) {
    restoreDraft();
  }
}, 500);
