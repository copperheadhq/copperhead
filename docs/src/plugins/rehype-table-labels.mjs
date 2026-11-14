/**
 * Build-time HTML tweaks for the markdown content:
 *
 * - Every <table> is wrapped in <div class="table-wrap"> so the table itself
 *   can be a real full-width table while the wrapper takes care of horizontal
 *   scrolling if it is ever too wide.
 * - Every body cell gets `data-label="<its column header>"`, so the
 *   stylesheet can stack rows into cards on narrow screens and still show
 *   which column each value came from.
 * - Inline code never breaks inside a token: a short single-token span
 *   (`--json`, `kicad-cli`) gets class "nowrap", and a multi-word span
 *   (`--model claude-code`) has each token wrapped in <span class="nowrap">
 *   so it can only wrap at the spaces. A token longer than NOWRAP_MAX_CHARS is
 *   left unmarked, so the stylesheet's overflow-wrap can break it rather than
 *   let it overflow a narrow column.
 *
 * See the "Tables" and "Inline code" blocks in src/styles/custom.css.
 */
const NOWRAP_MAX_CHARS = 30;

function textOf(node) {
  if (node.type === 'text') return node.value;
  return (node.children ?? []).map(textOf).join('');
}

function children(node, tag) {
  return (node.children ?? []).filter((c) => c.type === 'element' && c.tagName === tag);
}

function addClass(node, name) {
  const props = (node.properties ??= {});
  const existing = Array.isArray(props.className)
    ? props.className
    : typeof props.className === 'string'
      ? props.className.split(/\s+/).filter(Boolean)
      : [];
  if (!existing.includes(name)) props.className = [...existing, name];
}

function visit(node, fn, parent = null, inPre = false) {
  fn(node, parent, inPre);
  // Children of a <pre> are code-block content: expressive-code owns them, and
  // wrapping tokens in there would corrupt every sample.
  const next = inPre || (node.type === 'element' && node.tagName === 'pre');
  // Copied, because fn may replace this node in its parent as it goes.
  for (const child of [...(node.children ?? [])]) visit(child, fn, node, next);
}

export default function rehypeTableLabels() {
  return (tree) => {
    visit(tree, (node, parent, inPre) => {
      if (node.type !== 'element') return;

      if (node.tagName === 'code' && !inPre) {
        const text = textOf(node);
        if (!/\s/.test(text)) {
          if (text.length <= NOWRAP_MAX_CHARS) addClass(node, 'nowrap');
          return;
        }
        // Only touch the plain case: one text node, nothing nested.
        if (node.children.length === 1 && node.children[0].type === 'text') {
          node.children = text.split(/(\s+)/).map((part) =>
            /^\s+$/.test(part) || part.length > NOWRAP_MAX_CHARS
              ? { type: 'text', value: part }
              : { type: 'element', tagName: 'span', properties: { className: ['nowrap'] }, children: [{ type: 'text', value: part }] },
          );
        }
        return;
      }

      if (node.tagName !== 'table') return;

      const headerRow = children(node, 'thead').flatMap((t) => children(t, 'tr'))[0];
      if (headerRow) {
        const labels = children(headerRow, 'th').map((th) => textOf(th).trim());
        for (const tbody of children(node, 'tbody')) {
          for (const tr of children(tbody, 'tr')) {
            children(tr, 'td').forEach((td, i) => {
              if (labels[i]) td.properties = { ...td.properties, dataLabel: labels[i] };
            });
          }
        }
      }

      if (parent && !(parent.type === 'element' && parent.properties?.className?.includes?.('table-wrap'))) {
        const index = parent.children.indexOf(node);
        parent.children[index] = {
          type: 'element',
          tagName: 'div',
          properties: { className: ['table-wrap'] },
          children: [node],
        };
      }
    });
  };
}
