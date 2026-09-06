import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

const REPO = 'https://github.com/copperheadhq/copperhead';

// Served at the root of its own subdomain, docs.copperhead.sh. The apex,
// copperhead.sh, is a separate Cloudflare Worker (the copperhead-site repo),
// so Pages cannot own a path under it.
export default defineConfig({
  site: 'https://docs.copperhead.sh',
  integrations: [
    starlight({
      title: 'copperhead',
      description:
        'Cursor for circuit boards: an AI agent that designs, documents, and validates real PCBs on KiCad repositories',
      logo: { src: './src/assets/mark.svg', alt: '' },
      social: [
        { icon: 'external', label: 'copperhead.sh', href: 'https://copperhead.sh' },
        { icon: 'github', label: 'GitHub', href: REPO },
      ],
      editLink: { baseUrl: `${REPO}/edit/main/docs/` },
      lastUpdated: true,
      // Theme: see src/styles/custom.css for the palette and layout, and
      // src/components/ for the overridden header, sidebar, title, and theme toggle.
      components: {
        Header: './src/components/Header.astro',
        Sidebar: './src/components/Sidebar.astro',
        PageTitle: './src/components/PageTitle.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        Footer: './src/components/Footer.astro',
      },
      customCss: [
        '@fontsource-variable/inter',
        '@fontsource/ibm-plex-mono/400.css',
        '@fontsource/ibm-plex-mono/500.css',
        './src/styles/custom.css',
      ],
      expressiveCode: {
        styleOverrides: {
          borderRadius: '0.75rem',
          codeFontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          codeFontSize: '0.875rem',
          codeLineHeight: '1.65',
          codePaddingBlock: '0.875rem',
          codePaddingInline: '1rem',
          frames: {
            shadowColor: 'transparent',
            frameBoxShadowCssValue: 'none',
          },
        },
      },
      plugins: [
        starlightLlmsTxt({
          projectName: 'copperhead',
          description:
            'Cursor for circuit boards: an open-source (Apache-2.0) TypeScript CLI agent that designs, documents, and validates real PCBs from a prompt. It works directly on existing KiCad repositories, editing .kicad_sch / .kicad_pcb s-expression files, keeps markdown design docs as memory, and verifies every change by running kicad-cli ERC/DRC until the checks pass.',
          details: [
            'Key facts:',
            '',
            '- Install: `npm install -g copperhead` (Node.js >= 20, KiCad >= 8 with `kicad-cli` on PATH, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment).',
            '- Commands: `copperhead init` (scaffold docs/ from a schematic, idempotent), `copperhead do "<change>"` (propose, edit, verify, propagate, commit), `copperhead check` (ERC + DRC + doc drift + spec validation, no LLM calls, CI-safe, alias: `verify`), `copperhead sync` (verify whole design state, resolve drift), `copperhead create --brief brief.md` (product brief to full output package).',
            '- Two invariants: nothing starts without a validated change proposal (the edit tools are structurally unavailable until one exists), and nothing is "done" until ERC/DRC passes (failed verification rolls back to a git snapshot).',
            '- It is not an autorouter, not a new editor (KiCad remains the editor), and not the engineer of record (a human signs off).',
            `- Source: ${REPO}`,
          ].join('\n'),
          optionalLinks: [
            {
              label: 'Technical specification',
              url: `${REPO}/blob/main/openspec/specs/SPEC.md`,
              description:
                'The complete spec, including architecture, tool schemas, safety rails, and binary acceptance criteria.',
            },
            {
              label: 'README',
              url: `${REPO}/blob/main/README.md`,
              description: 'Project overview, install, maturity notes, and project layout.',
            },
            {
              label: 'Contributing',
              url: `${REPO}/blob/main/CONTRIBUTING.md`,
              description: 'Setup, workflow, and the one-time CLA.',
            },
            {
              label: 'Example briefs',
              url: `${REPO}/tree/main/examples`,
              description: 'Ready-made product briefs sorted by difficulty.',
            },
          ],
        }),
      ],
      head: [
        { tag: 'meta', attrs: { name: 'theme-color', content: '#b87333' } },
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '32x32' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
        { tag: 'link', attrs: { rel: 'manifest', href: '/site.webmanifest' } },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://docs.copperhead.sh/og.png' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://docs.copperhead.sh/og.png' } },
      ],
      // `data-icon` picks the leading icon for each row; see SidebarSublist.astro.
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Welcome', link: '/', attrs: { 'data-icon': 'star' } },
            { label: 'Introduction', link: '/getting-started/introduction/', attrs: { 'data-icon': 'information' } },
            { label: 'Quickstart', link: '/getting-started/quickstart/', attrs: { 'data-icon': 'rocket' } },
            { label: 'Agent install', link: '/getting-started/agent-install/', attrs: { 'data-icon': 'puzzle' } },
            { label: 'Simple demo', link: '/getting-started/demo/', attrs: { 'data-icon': 'laptop' } },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'The agent loop', link: '/concepts/agent-loop/', attrs: { 'data-icon': 'random' } },
            { label: 'Guardrails', link: '/concepts/guardrails/', attrs: { 'data-icon': 'padlock' } },
            { label: 'Docs as memory', link: '/concepts/docs-as-memory/', attrs: { 'data-icon': 'open-book' } },
          ],
        },
        {
          label: 'Workflows',
          items: [
            { label: 'Design from a brief', link: '/workflows/create-from-brief/', attrs: { 'data-icon': 'add-document' } },
            { label: 'Edit an existing board', link: '/workflows/edit-existing-board/', attrs: { 'data-icon': 'pencil' } },
            { label: 'Verify and sync', link: '/workflows/verify-and-sync/', attrs: { 'data-icon': 'approve-check' } },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI', link: '/reference/cli/', attrs: { 'data-icon': 'forward-slash' } },
            { label: 'Configuration', link: '/reference/configuration/', attrs: { 'data-icon': 'setting' } },
            { label: 'Schematic legibility rules', link: '/reference/schematic-legibility/', attrs: { 'data-icon': 'list-format' } },
            { label: 'How schematics are drafted', link: '/reference/schematic-drafting/', attrs: { 'data-icon': 'pen' } },
            { label: 'The schematic intent file', link: '/reference/schematic-intent/', attrs: { 'data-icon': 'document' } },
            {
              label: 'Technical spec',
              link: `${REPO}/blob/main/openspec/specs/SPEC.md`,
              attrs: { target: '_blank', rel: 'noopener', 'data-icon': 'external' },
            },
          ],
        },
      ],
    }),
  ],
});
