import { Extension, InputRule } from '@tiptap/core';

function inCodeContext(state) {
  const { $from } = state.selection;
  if ($from.parent.type.name === 'codeBlock') return true;
  return $from.marks().some((m) => m.type.name === 'code');
}

function simpleReplace(find, replacement) {
  return new InputRule({
    find,
    handler: ({ state, range }) => {
      if (inCodeContext(state)) return;
      state.tr.insertText(replacement, range.from, range.to);
    },
  });
}

function smartQuote(find, openChar, closeChar) {
  return new InputRule({
    find,
    handler: ({ state, range }) => {
      if (inCodeContext(state)) return;
      const before = state.doc.textBetween(Math.max(0, range.from - 1), range.from);
      const isOpen = !before || /[\s\(\[\{<—–]/.test(before);
      state.tr.insertText(isOpen ? openChar : closeChar, range.from, range.to);
    },
  });
}

export const Typography = Extension.create({
  name: 'typography',

  addInputRules() {
    return [
      simpleReplace(/--$/, '—'),
      simpleReplace(/\.\.\.$/, '…'),
      simpleReplace(/\(c\)$/i, '©'),
      simpleReplace(/\(r\)$/i, '®'),
      simpleReplace(/\(tm\)$/i, '™'),
      smartQuote(/"$/, '“', '”'),
      smartQuote(/'$/, '‘', '’'),
    ];
  },
});
