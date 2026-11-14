import { describe, it, expect } from 'vitest';
import {
  CREATE_ORIGIN,
  checkDocumentationPresence,
  draftQualitySection,
  isDraftQualityHeading,
  isCreateProducedRepo,
  isFilledDraftQuality,
} from '../src/kicad/fab.js';

const FILLED_LAYOUT = `# Layout intent

## Draft quality

Power and critical nets routed; ratsnest remains on low-speed GPIO.
A human should re-check USB differential pair length before fab.
`;

const INIT_LAYOUT = `# Layout intent

Placement and routing intent: keepouts, pours, ESD placement.

## Draft quality

<!-- copperhead writes an honest assessment here after any layout pass -->
`;

const NO_SECTION_LAYOUT = `# Layout intent

Placement notes only; no draft-quality assessment yet.
`;

describe('isCreateProducedRepo', () => {
  it('detects origin create in config.json', () => {
    expect(isCreateProducedRepo({ origin: CREATE_ORIGIN })).toBe(true);
    expect(isCreateProducedRepo({ origin: 'init' })).toBe(false);
    expect(isCreateProducedRepo({})).toBe(false);
    expect(isCreateProducedRepo(null)).toBe(false);
  });
});

describe('draftQualitySection / isFilledDraftQuality', () => {
  it('accepts a numbered Draft quality heading, as the sibling headings are numbered (#327)', () => {
    const body = '\nPower routed, 6 connections unrouted.\n';
    for (const h of ['## Draft quality', '## 4. Draft quality', '## 4) Draft quality', '##  12.  Draft quality  ', '## 4.1 Draft quality', '## 4.1. Draft quality', '## Draft Quality']) {
      expect(draftQualitySection(`# Layout\n\n## 1. Placement\n\ntext\n\n${h}\n${body}\n## 5. Next\n`), h).toBe(body);
      expect(isDraftQualityHeading(h), h).toBe(true);
    }
    for (const h of ['### Draft quality', '## Draft quality notes', '## 4 Draft quality', 'Draft quality', '## Draft']) {
      expect(isDraftQualityHeading(h), h).toBe(false);
    }
    expect(draftQualitySection('# Layout\n\n## Draft quality notes\n\ntext\n')).toBeNull();
  });

  it('returns null when the heading is absent', () => {
    expect(draftQualitySection(NO_SECTION_LAYOUT)).toBeNull();
  });

  it('treats init scaffold (heading + HTML comment) as empty', () => {
    const body = draftQualitySection(INIT_LAYOUT);
    expect(body).not.toBeNull();
    expect(isFilledDraftQuality(body!)).toBe(false);
  });

  it('treats real prose as filled', () => {
    const body = draftQualitySection(FILLED_LAYOUT);
    expect(body).not.toBeNull();
    expect(isFilledDraftQuality(body!)).toBe(true);
  });
});

describe('checkDocumentationPresence', () => {
  it('fails when LAYOUT.md has no ## Draft quality section (delta spec)', () => {
    const r = checkDocumentationPresence({
      layoutMd: NO_SECTION_LAYOUT,
      devplanExists: true,
      isCreateRepo: false,
    });
    expect(r.status).toBe('fail');
    expect(r.violations).toEqual([
      {
        claim: 'release-ready',
        actual: 'missing ## Draft quality section',
        location: 'docs/LAYOUT.md',
      },
    ]);
  });

  it('fails when ## Draft quality exists but is empty (init scaffold)', () => {
    const r = checkDocumentationPresence({
      layoutMd: INIT_LAYOUT,
      devplanExists: false,
      isCreateRepo: false,
    });
    expect(r.status).toBe('fail');
    expect(r.violations[0]).toMatchObject({
      claim: 'release-ready',
      actual: '## Draft quality section is empty',
      location: 'docs/LAYOUT.md',
    });
  });

  it('fails when LAYOUT.md itself is missing', () => {
    const r = checkDocumentationPresence({
      layoutMd: null,
      devplanExists: true,
      isCreateRepo: false,
    });
    expect(r.status).toBe('fail');
    expect(r.violations[0]?.actual).toBe('LAYOUT.md missing');
  });

  it('fails create repos missing DEVPLAN.md', () => {
    const r = checkDocumentationPresence({
      layoutMd: FILLED_LAYOUT,
      devplanExists: false,
      isCreateRepo: true,
    });
    expect(r.status).toBe('fail');
    expect(r.violations).toEqual([
      {
        claim: 'release-ready',
        actual: 'missing',
        location: 'docs/DEVPLAN.md',
      },
    ]);
  });

  it('does not require DEVPLAN.md for init-only repos', () => {
    const r = checkDocumentationPresence({
      layoutMd: FILLED_LAYOUT,
      devplanExists: false,
      isCreateRepo: false,
    });
    expect(r.status).toBe('pass');
    expect(r.violations).toEqual([]);
  });

  it('passes a complete create doc set', () => {
    const r = checkDocumentationPresence({
      layoutMd: FILLED_LAYOUT,
      devplanExists: true,
      isCreateRepo: true,
    });
    expect(r.status).toBe('pass');
    expect(r.violations).toEqual([]);
  });

  it('can report both LAYOUT and DEVPLAN failures together', () => {
    const r = checkDocumentationPresence({
      layoutMd: NO_SECTION_LAYOUT,
      devplanExists: false,
      isCreateRepo: true,
    });
    expect(r.status).toBe('fail');
    expect(r.violations).toHaveLength(2);
    expect(r.violations.map((v) => v.location)).toEqual([
      'docs/LAYOUT.md',
      'docs/DEVPLAN.md',
    ]);
  });
});
