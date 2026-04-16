import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const collapseKey = new PluginKey('collapse');

function headingKey(node) {
  return `h${node.attrs.level}:${node.textContent}`;
}

function buildDecorations(state, collapsed) {
  const decorations = [];
  const blocks = [];

  state.doc.forEach((node, offset) => {
    blocks.push({ node, pos: offset });
  });

  for (let i = 0; i < blocks.length; i++) {
    const { node, pos } = blocks[i];
    if (node.type.name !== 'heading') continue;

    const key = headingKey(node);
    const isCollapsed = collapsed.has(key);

    // Chevron widget inside heading, before text
    decorations.push(
      Decoration.widget(
        pos + 1,
        () => {
          const span = document.createElement('span');
          span.className = `collapse-chevron${isCollapsed ? ' is-collapsed' : ''}`;
          span.dataset.pos = String(pos);
          span.textContent = isCollapsed ? '\u25B8 ' : '\u25BE ';
          span.contentEditable = 'false';
          return span;
        },
        { side: -1, key: `chevron-${pos}` }
      )
    );

    // If collapsed, hide all blocks until next heading of same or higher level
    if (isCollapsed) {
      const level = node.attrs.level;
      for (let j = i + 1; j < blocks.length; j++) {
        const next = blocks[j];
        if (next.node.type.name === 'heading' && next.node.attrs.level <= level) break;
        decorations.push(
          Decoration.node(next.pos, next.pos + next.node.nodeSize, {
            class: 'collapsed-content',
          })
        );
      }
    }
  }

  return DecorationSet.create(state.doc, decorations);
}

export const CollapsibleHeadings = Extension.create({
  name: 'collapsibleHeadings',

  addStorage() {
    return { collapsed: new Set() };
  },

  addProseMirrorPlugins() {
    const ext = this;

    return [
      new Plugin({
        key: collapseKey,

        state: {
          init(_, state) {
            return buildDecorations(state, ext.storage.collapsed);
          },
          apply(tr, old, _oldState, newState) {
            if (tr.docChanged || tr.getMeta(collapseKey)) {
              return buildDecorations(newState, ext.storage.collapsed);
            }
            return old;
          },
        },

        props: {
          decorations(state) {
            return this.getState(state);
          },

          handleDOMEvents: {
            mousedown(view, event) {
              const chevron = event.target.closest('.collapse-chevron');
              if (!chevron) return false;

              event.preventDefault();
              event.stopPropagation();

              const pos = parseInt(chevron.dataset.pos, 10);
              const node = view.state.doc.nodeAt(pos);
              if (!node || node.type.name !== 'heading') return false;

              const key = headingKey(node);
              if (ext.storage.collapsed.has(key)) {
                ext.storage.collapsed.delete(key);
              } else {
                ext.storage.collapsed.add(key);
              }

              view.dispatch(view.state.tr.setMeta(collapseKey, true));
              return true;
            },
          },
        },
      }),
    ];
  },
});
