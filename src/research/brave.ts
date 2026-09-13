import type { RunContext } from '../agent/context.js';
import { requestJson } from './net.js';
import type { SearchProvider, SearchResult } from './providers.js';

export class BraveSearchProvider implements SearchProvider {
  async search(ctx: RunContext, query: string): Promise<SearchResult[]> {
    const key = process.env.BRAVE_API_KEY;
    if (!key) throw new Error('BRAVE_API_KEY is not configured');
    const data = (await requestJson(ctx, `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
      headers: { accept: 'application/json', 'x-subscription-token': key },
    })) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (data.web?.results ?? []).flatMap((r) =>
      r.title && r.url ? [{ title: r.title, url: r.url, snippet: r.description ?? '' }] : [],
    );
  }
}
