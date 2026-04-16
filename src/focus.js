import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const FocusMode = Extension.create({
  name: 'focusMode',

  addStorage() {
    return { active: false };
  },

  addProseMirrorPlugins() {
    const ext = this;
    return [
      new Plugin({
        props: {
          decorations(state) {
            if (!ext.storage.active) return null;
            const { $from } = state.selection;
            if ($from.depth === 0) return null;
            const pos = $from.start(1) - 1;
            const node = state.doc.nodeAt(pos);
            if (!node) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + node.nodeSize, { class: 'is-focused' }),
            ]);
          },
        },
      }),
    ];
  },
});
