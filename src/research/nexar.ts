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

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalize(value: unknown): PartResult | null {
  const part = object(value) as NexarPart;
  if (typeof part.mpn !== 'string' || !part.mpn.trim()) return null;
  const stockByDistributor: StockByDistributor[] = [];
  const priceBreaks: PriceBreak[] = [];
  for (const sellerValue of Array.isArray(part.sellers) ? part.sellers : []) {
    const seller = object(sellerValue);
    for (const offerValue of Array.isArray(seller.offers) ? seller.offers : []) {
      const offer = object(offerValue);
      const inventory = offer.inventoryLevel;
      if (inventory !== undefined) {
        const company = object(offer.company);
        stockByDistributor.push({
          distributor: typeof company.name === 'string' ? company.name : 'unknown',
          quantity: Number(inventory) || 0,
        });
      }
      for (const priceValue of Array.isArray(offer.prices) ? offer.prices : []) {
        const price = object(priceValue);
        if (price.quantity !== undefined && price.price !== undefined) {
          priceBreaks.push({
            quantity: Number(price.quantity),
            unitPrice: Number(price.price),
            ...(typeof price.currency === 'string' ? { currency: price.currency } : {}),
          });
        }
      }
    }
  }
  const manufacturer = object(part.manufacturer);
  const datasheet = object(part.bestDatasheet);
  return {
    mpn: part.mpn,
    manufacturer: typeof manufacturer.name === 'string' ? manufacturer.name : 'unknown',
    lifecycle: typeof part.lifecycleStatus === 'string' ? part.lifecycleStatus : 'unknown',
    stockTotal: stockByDistributor.reduce((sum, s) => sum + s.quantity, 0),
    stockByDistributor,
    priceBreaks,
    ...((typeof datasheet.url === 'string' ? datasheet.url : typeof part.datasheetUrl === 'string' ? part.datasheetUrl : undefined)
      ? { datasheetUrl: typeof datasheet.url === 'string' ? datasheet.url : part.datasheetUrl! }
      : {}),
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
    const data = object(await requestJson(ctx, 'https://identity.nexar.com/connect/token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body,
    }));
    if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Nexar token response did not contain access_token');
    this.token = data.access_token;
    return this.token;
  }

  async search(ctx: RunContext, query: string, mpn?: string): Promise<PartResult[]> {
    const token = await this.accessToken(ctx);
    const gql = `query Search($q: String!) { supSearch(q: $q, limit: 20) { results { part { mpn manufacturer { name } lifecycleStatus bestDatasheet { url } sellers { offers { inventoryLevel prices { quantity price currency } company { name } } } } } } }`;
    const data = object(await requestJson(ctx, 'https://api.nexar.com/graphql', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: gql, variables: { q: mpn ?? query } }),
    }));
    const errors = Array.isArray(data.errors) ? data.errors : [];
    if (errors.length) throw new Error(errors.map((entry) => {
      const message = object(entry).message;
      return typeof message === 'string' ? message : 'Nexar error';
    }).join('; '));
    const payload = object(data.data);
    const search = object(payload.supSearch);
    const results = Array.isArray(search.results) ? search.results : [];
    return results.flatMap((result) => {
      const part = normalize(object(result).part);
      return part ? [part] : [];
    });
  }
}
