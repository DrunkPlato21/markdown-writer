import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const searchKey = new PluginKey('search');

export const Search = Extension.create({
  name: 'search',

  addStorage() {
    return {
      term: '',
      replaceTerm: '',
      results: [],
      currentIndex: -1,
    };
  },

  addProseMirrorPlugins() {
    const ext = this;

    return [
      new Plugin({
        key: searchKey,
        state: {
          init() {
            return DecorationSet.empty;
          },
          apply(_tr, _old, _oldState, newState) {
            const term = ext.storage.term;
            if (!term) {
              ext.storage.results = [];
              return DecorationSet.empty;
            }

            const results = [];
            const decorations = [];
            const termLower = term.toLowerCase();

            newState.doc.descendants((node, pos) => {
              if (!node.isText) return;
              const textLower = node.text.toLowerCase();
              let idx = 0;
              while (true) {
                idx = textLower.indexOf(termLower, idx);
                if (idx === -1) break;
                results.push({ from: pos + idx, to: pos + idx + term.length });
                idx += 1;
              }
            });

            ext.storage.results = results;
            if (ext.storage.currentIndex >= results.length) {
              ext.storage.currentIndex = results.length > 0 ? 0 : -1;
            }
            if (results.length > 0 && ext.storage.currentIndex === -1) {
              ext.storage.currentIndex = 0;
            }

            results.forEach((match, i) => {
              decorations.push(
                Decoration.inline(match.from, match.to, {
                  class: i === ext.storage.currentIndex ? 'search-match current' : 'search-match',
                })
              );
            });

            return DecorationSet.create(newState.doc, decorations);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
