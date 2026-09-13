import type { RunContext } from '../agent/context.js';
import { requestJson } from './net.js';
import type { PartDataProvider, PartResult, PriceBreak, StockByDistributor } from './providers.js';

const JLCSEARCH_URL = 'https://jlcsearch.tscircuit.com/api/search';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value.replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = text(value);
    if (found) return found;
  }
  return undefined;
}

function normalizePriceBreaks(component: UnknownRecord, extra: UnknownRecord): PriceBreak[] {
  const candidates = Array.isArray(extra.prices) ? extra.prices : Array.isArray(component.prices) ? component.prices : [];
  const breaks = candidates.flatMap((raw) => {
    const entry = record(raw);
    const quantity = number(entry.quantity ?? entry.qFrom ?? entry.minimumQuantity ?? entry.minQuantity);
    const unitPrice = number(entry.price ?? entry.unitPrice ?? entry.amount);
    if (quantity === undefined || unitPrice === undefined) return [];
    const currency = firstText(entry.currency);
    return [{ quantity, unitPrice, ...(currency ? { currency } : {}) }];
  });
  if (breaks.length) return breaks;
  const unitPrice = number(component.price1 ?? component.price ?? extra.price1 ?? extra.price);
  return unitPrice === undefined ? [] : [{ quantity: 1, unitPrice }];
}

function normalize(component: unknown): PartResult | null {
  const raw = record(component);
  const extra = record(raw.extra);
  const manufacturer = record(extra.manufacturer);
  const mpn = firstText(extra.mpn, raw.mfr, raw.mpn, extra.manufacturerPartNumber, extra.number);
  if (!mpn) return null;
  const stock = number(extra.quantity ?? raw.stock ?? raw.quantity) ?? 0;
  const stockByDistributor: StockByDistributor[] = [{ distributor: 'LCSC/JLCPCB', quantity: stock }];
  const datasheet = record(extra.datasheet);
  const datasheetUrl = firstText(datasheet.pdf, extra.datasheet_pdf, raw.datasheetUrl);
  const lifecycle = firstText(extra.lifecycle, raw.lifecycle, raw.lifecycleStatus) ?? 'unknown';
  return {
    mpn,
    manufacturer: firstText(manufacturer.name, extra.manufacturerName, raw.manufacturer) ?? 'unknown',
    lifecycle,
    stockTotal: stock,
    stockByDistributor,
    priceBreaks: normalizePriceBreaks(raw, extra),
    ...(datasheetUrl ? { datasheetUrl } : {}),
    source: 'jlcsearch',
  };
}

interface JlcSearchResponse {
  components?: unknown[];
}

export class JlcSearchProvider implements PartDataProvider {
  async search(ctx: RunContext, query: string, mpn?: string): Promise<PartResult[]> {
    const target = (mpn ?? query).trim();
    const url = `${JLCSEARCH_URL}?q=${encodeURIComponent(target)}&limit=20&full=true`;
    const data = await requestJson(ctx, url, { headers: { accept: 'application/json' } }) as JlcSearchResponse;
    return (data.components ?? []).flatMap((component) => {
      const part = normalize(component);
      return part ? [part] : [];
    });
  }
}
