// ═══════════════════════════════════════════
// SynaBun Neural Interface — Multi-Select Bar
// Shows bulk actions when multiple nodes are selected
// ═══════════════════════════════════════════

import { state, emit, on } from './state.js';

const $ = (id) => document.getElementById(id);

export function updateMultiSelectBar() {
  const bar = $('multi-select-bar');
  const count = $('multi-select-count');
  if (!bar) return;

  if (state.multiSelected.size > 0) {
    bar.classList.add('open');
    if (count) count.textContent = `${state.multiSelected.size} selected`;
  } else {
    bar.classList.remove('open');
  }
}

export function clearMultiSelect() {
  state.multiSelected.clear();
  updateMultiSelectBar();
  emit('multiselect:cleared');
}

export function initMultiSelect() {
  const exportBtn = $('multi-select-export');
  const trashBtn = $('multi-select-trash');
  const clearBtn = $('multi-select-clear');
  const moveCatBtn = $('multi-select-move-cat');

  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      // Export all selected memories as markdown
      const nodes = state.allNodes.filter(n => state.multiSelected.has(n.id));
      if (!nodes.length) return;

      let md = `# Exported Memories (${nodes.length})\n\n`;
      nodes.forEach(n => {
        const p = n.payload || n;
        md += `## ${p.category || 'uncategorized'}\n`;
        md += `**Importance:** ${p.importance || 5}\n`;
        if (p.tags?.length) md += `**Tags:** ${p.tags.join(', ')}\n`;
        md += `\n${p.content || ''}\n\n---\n\n`;
      });

      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `memories-export-${Date.now()}.md`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  if (trashBtn) {
    trashBtn.addEventListener('click', async () => {
      const ids = [...state.multiSelected];
      if (!ids.length) return;
      if (!confirm(`Move ${ids.length} memories to trash?`)) return;

      for (const id of ids) {
        try {
          await fetch(`/api/memory/${id}`, { method: 'DELETE' });
        } catch {}
      }
      clearMultiSelect();
      emit('graph:reload');
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', clearMultiSelect);
  }

  if (moveCatBtn) {
    moveCatBtn.addEventListener('click', () => {
      emit('multiselect:move-category', [...state.multiSelected]);
    });
  }

  on('multiselect:update', updateMultiSelectBar);
}
