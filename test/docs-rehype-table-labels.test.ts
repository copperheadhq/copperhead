import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain .mjs plugin, no types
import rehypeTableLabels from '../docs/src/plugins/rehype-table-labels.mjs';

// Minimal hast helpers. The plugin only ever reads and writes plain objects,
// so the docs site's build dependencies are not needed to exercise it.
const el = (tagName: string, children: any[] = [], properties: any = {}) => ({
  type: 'element',
  tagName,
  properties,
  children,
});
const text = (value: string) => ({ type: 'text', value });
const root = (children: any[]) => ({ type: 'root', children });

const run = (tree: any) => {
  rehypeTableLabels()(tree);
  return tree;
};

const find = (node: any, pred: (n: any) => boolean): any => {
  if (pred(node)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, pred);
    if (hit) return hit;
  }
  return undefined;
};

const classesOf = (node: any) => {
  const c = node.properties?.className;
  return Array.isArray(c) ? c : typeof c === 'string' ? c.split(/\s+/).filter(Boolean) : [];
};

const table = (headers: string[], rows: string[][]) =>
  el('table', [
    el('thead', [el('tr', headers.map((h) => el('th', [text(h)])))]),
    el('tbody', rows.map((cells) => el('tr', cells.map((c) => el('td', [text(c)]))))),
  ]);

describe('rehype-table-labels: tables', () => {
  it('wraps a table in .table-wrap so the wrapper owns the overflow', () => {
    const tree = run(root([table(['Option'], [['--json']])]));

    const wrap = tree.children[0];
    expect(wrap.tagName).toBe('div');
    expect(classesOf(wrap)).toContain('table-wrap');
    expect(wrap.children[0].tagName).toBe('table');
  });

  it('labels every body cell with its column header', () => {
    const tree = run(
      root([table(['Option', 'Meaning'], [['--json', 'machine output'], ['--quiet', 'no output']])]),
    );

    const cells = [];
    find(tree, (n) => {
      if (n.tagName === 'td') cells.push(n.properties.dataLabel);
      return false;
    });
    expect(cells).toEqual(['Option', 'Meaning', 'Option', 'Meaning']);
  });

  it('leaves a cell unlabelled when the row is wider than the header', () => {
    const tree = run(root([table(['Option'], [['--json', 'stray']])]));

    const row = find(tree, (n: any) => n.tagName === 'tr' && n.children[0]?.tagName === 'td');
    expect(row.children[0].properties.dataLabel).toBe('Option');
    expect(row.children[1].properties?.dataLabel).toBeUndefined();
  });

  it('does not wrap a table that is already wrapped', () => {
    const tree = run(root([el('div', [table(['Option'], [['--json']])], { className: ['table-wrap'] })]));

    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].children[0].tagName).toBe('table');
  });

  it('tolerates a table with no header row', () => {
    const tree = run(root([el('table', [el('tbody', [el('tr', [el('td', [text('x')])])])])]));

    const cell = find(tree, (n: any) => n.tagName === 'td');
    expect(cell.properties?.dataLabel).toBeUndefined();
    expect(classesOf(tree.children[0])).toContain('table-wrap');
  });
});

describe('rehype-table-labels: inline code', () => {
  it('marks a short single-token span nowrap, so it cannot break at a hyphen', () => {
    const tree = run(root([el('p', [el('code', [text('--json')])])]));

    const code = find(tree, (n: any) => n.tagName === 'code');
    expect(classesOf(code)).toContain('nowrap');
    expect(code.children).toEqual([text('--json')]);
  });

  it('splits a multi-word span so it can only break at the spaces', () => {
    const tree = run(root([el('p', [el('code', [text('copperhead init')])])]));

    const code = find(tree, (n: any) => n.tagName === 'code');
    expect(classesOf(code)).not.toContain('nowrap');
    expect(code.children.map((c: any) => (c.type === 'text' ? c.value : c.children[0].value))).toEqual([
      'copperhead',
      ' ',
      'init',
    ]);
    const tokens = code.children.filter((c: any) => c.type === 'element');
    expect(tokens).toHaveLength(2);
    for (const t of tokens) expect(classesOf(t)).toContain('nowrap');
  });

  it('leaves a token longer than the cap free to wrap, rather than forcing an overflow', () => {
    const long = 'a'.repeat(31);
    const tree = run(root([el('p', [el('code', [text(long)])])]));

    const code = find(tree, (n: any) => n.tagName === 'code');
    expect(classesOf(code)).not.toContain('nowrap');
    expect(code.children).toEqual([text(long)]);
  });

  it('leaves an over-long token inside a multi-word span unmarked', () => {
    const long = 'b'.repeat(31);
    const tree = run(root([el('p', [el('code', [text(`run ${long}`)])])]));

    const code = find(tree, (n: any) => n.tagName === 'code');
    const marked = code.children.filter((c: any) => c.type === 'element');
    expect(marked).toHaveLength(1);
    expect(marked[0].children[0].value).toBe('run');
    expect(code.children.some((c: any) => c.type === 'text' && c.value === long)).toBe(true);
  });

  it('never touches code inside a <pre>: expressive-code owns code blocks', () => {
    const tree = run(root([el('pre', [el('code', [el('span', [text('--json')])])])]));

    const code = find(tree, (n: any) => n.tagName === 'code');
    expect(classesOf(code)).not.toContain('nowrap');
    const span = find(tree, (n: any) => n.tagName === 'span');
    expect(classesOf(span)).not.toContain('nowrap');
  });

  it('preserves an existing class when adding nowrap', () => {
    const tree = run(root([el('p', [el('code', [text('--json')], { className: ['expressive'] })])]));

    const code = find(tree, (n: any) => n.tagName === 'code');
    expect(classesOf(code)).toEqual(['expressive', 'nowrap']);
  });

  it('leaves a span with nested markup structurally alone', () => {
    const nested = el('code', [text('a '), el('em', [text('b')])]);
    const tree = run(root([el('p', [nested])]));

    const code = find(tree, (n: any) => n.tagName === 'code');
    expect(code.children).toHaveLength(2);
    expect(code.children[1].tagName).toBe('em');
  });
});
