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
      social: [
        { icon: 'external', label: 'copperhead.sh', href: 'https://copperhead.sh' },
        { icon: 'github', label: 'GitHub', href: REPO },
      ],
      editLink: { baseUrl: `${REPO}/edit/main/docs/` },
      lastUpdated: true,
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
            '- copperhead cloud (app.copperhead.sh) is the optional hosted console: sign in with GitHub or email, connect a repository through the copperhead GitHub App, and run `copperhead check` hosted with a live streamed transcript. It stores identity, tenancy, and run metadata only, never KiCad files or model keys; the CLI needs no account.',
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
      customCss: ['./src/styles/custom.css'],
      head: [
        { tag: 'meta', attrs: { name: 'theme-color', content: '#b87333' } },
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '32x32' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
        { tag: 'link', attrs: { rel: 'manifest', href: '/site.webmanifest' } },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://docs.copperhead.sh/og.png' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://docs.copperhead.sh/og.png' } },
      ],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Introduction', link: '/getting-started/introduction/' },
            { label: 'Quickstart', link: '/getting-started/quickstart/' },
            { label: 'Agent install', link: '/getting-started/agent-install/' },
            { label: 'Simple demo', link: '/getting-started/demo/' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'The agent loop', link: '/concepts/agent-loop/' },
            { label: 'Guardrails', link: '/concepts/guardrails/' },
            { label: 'Docs as memory', link: '/concepts/docs-as-memory/' },
          ],
        },
        {
          label: 'Workflows',
          items: [
            { label: 'Design from a brief', link: '/workflows/create-from-brief/' },
            { label: 'Edit an existing board', link: '/workflows/edit-existing-board/' },
            { label: 'Verify and sync', link: '/workflows/verify-and-sync/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI', link: '/reference/cli/' },
            { label: 'Configuration', link: '/reference/configuration/' },
            { label: 'Schematic legibility rules', link: '/reference/schematic-legibility/' },
            { label: 'How schematics are drafted', link: '/reference/schematic-drafting/' },
            { label: 'The schematic intent file', link: '/reference/schematic-intent/' },
          ],
        },
        {
          label: 'Cloud console',
          items: [
            { label: 'Overview', link: '/cloud/overview/' },
            { label: 'Sign in and organizations', link: '/cloud/sign-in-and-orgs/' },
            { label: 'Connect a repository', link: '/cloud/connect-a-repository/' },
            { label: 'Hosted check runs', link: '/cloud/hosted-checks/' },
            { label: 'Troubleshooting', link: '/cloud/troubleshooting/' },
          ],
        },
        {
          label: 'Technical spec',
          link: `${REPO}/blob/main/openspec/specs/SPEC.md`,
          attrs: { target: '_blank' },
        },
      ],
    }),
  ],
});
