import type { RunContext } from '../agent/context.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface StockByDistributor {
  distributor: string;
  quantity: number;
}

export interface PriceBreak {
  quantity: number;
  unitPrice: number;
  currency?: string;
}

export interface PartResult {
  mpn: string;
  manufacturer: string;
  lifecycle: string;
  stockTotal: number;
  stockByDistributor: StockByDistributor[];
  priceBreaks: PriceBreak[];
  datasheetUrl?: string;
  source?: string;
}

export interface SearchProvider {
  search(ctx: RunContext, query: string): Promise<SearchResult[]>;
}

export interface PartDataProvider {
  search(ctx: RunContext, query: string, mpn?: string): Promise<PartResult[]>;
}
