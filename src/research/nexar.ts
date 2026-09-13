import type { RunContext } from '../agent/context.js';
import { requestJson } from './net.js';
import type { PartDataProvider, PartResult, PriceBreak, StockByDistributor } from './providers.js';

interface NexarPart {
  mpn?: string;
  manufacturer?: { name?: string };
  lifecycleStatus?: string;
  sellers?: { offers?: { inventoryLevel?: number; prices?: { quantity?: number; price?: number; currency?: string }[]; company?: { name?: string } }[] }[];
  specs?: unknown;
  bestDatasheet?: { url?: string };
  datasheetUrl?: string;
}

function normalize(part: NexarPart): PartResult | null {
  if (!part.mpn) return null;
  const stockByDistributor: StockByDistributor[] = [];
  const priceBreaks: PriceBreak[] = [];
  for (const seller of part.sellers ?? []) {
    for (const offer of seller.offers ?? []) {
      if (offer.inventoryLevel !== undefined) stockByDistributor.push({ distributor: offer.company?.name ?? 'unknown', quantity: Number(offer.inventoryLevel) || 0 });
      for (const price of offer.prices ?? []) {
        if (price.quantity !== undefined && price.price !== undefined) priceBreaks.push({ quantity: Number(price.quantity), unitPrice: Number(price.price), ...(price.currency ? { currency: price.currency } : {}) });
      }
    }
  }
  return {
    mpn: part.mpn,
    manufacturer: part.manufacturer?.name ?? 'unknown',
    lifecycle: part.lifecycleStatus ?? 'unknown',
    stockTotal: stockByDistributor.reduce((sum, s) => sum + s.quantity, 0),
    stockByDistributor,
    priceBreaks,
    datasheetUrl: part.bestDatasheet?.url ?? part.datasheetUrl,
    source: 'nexar',
  };
}

export class NexarPartProvider implements PartDataProvider {
  private token: string | null = null;

  private async accessToken(ctx: RunContext): Promise<string> {
    if (this.token) return this.token;
    const clientId = process.env.NEXAR_CLIENT_ID;
    const secret = process.env.NEXAR_CLIENT_SECRET;
    if (!clientId || !secret) throw new Error('NEXAR_CLIENT_ID and NEXAR_CLIENT_SECRET are required');
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret,
      scope: 'supply.domain',
    });
    const data = (await requestJson(ctx, 'https://identity.nexar.com/connect/token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body,
    })) as { access_token?: string };
    if (!data.access_token) throw new Error('Nexar token response did not contain access_token');
    this.token = data.access_token;
    return this.token;
  }

  async search(ctx: RunContext, query: string, mpn?: string): Promise<PartResult[]> {
    const token = await this.accessToken(ctx);
    const gql = `query Search($q: String!) { supSearch(q: $q, limit: 20) { results { part { mpn manufacturer { name } lifecycleStatus bestDatasheet { url } sellers { offers { inventoryLevel prices { quantity price currency } company { name } } } } } } }`;
    const data = (await requestJson(ctx, 'https://api.nexar.com/graphql', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: gql, variables: { q: mpn ?? query } }),
    })) as { data?: { supSearch?: { results?: { part?: NexarPart }[] } }; errors?: { message?: string }[] };
    if (data.errors?.length) throw new Error(data.errors.map((e) => e.message ?? 'Nexar error').join('; '));
    return (data.data?.supSearch?.results ?? []).flatMap((r) => { const p = normalize(r.part ?? {}); return p ? [p] : []; });
  }
}
