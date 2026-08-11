export interface CatalogComponent {
  lcsc: number;
  mfr: string;
  package: string;
  stock: number;
  price: number;
}

export interface CatalogItem {
  lcscCode: string;
  mfr: string;
  package: string;
  stock: number;
  price: number;
}

export type MpnStatus = 'RESOLVED' | 'NO STOCK' | 'NOT FOUND' | 'SKIPPED' | 'LOOKUP FAILED';

export interface VerificationResult {
  refdes: string;
  mpn: string;
  status: MpnStatus;
  lcscCode?: string;
  candidates?: CatalogItem[];
}

/**
 * Queries the JLC/LCSC component catalog using the public jlcsearch API.
 */
export async function queryPartCatalog(mpn: string): Promise<CatalogItem[]> {
  const url = `https://jlcsearch.tscircuit.com/api/search?q=${encodeURIComponent(mpn)}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`Failed to fetch catalog: ${response.statusText}`);
    }
    const data = (await response.json()) as { components?: CatalogComponent[] };
    if (!data.components || !Array.isArray(data.components)) {
      return [];
    }
    return data.components.map((c) => ({
      lcscCode: `C${c.lcsc}`,
      mfr: c.mfr,
      package: c.package,
      stock: c.stock,
      price: c.price,
    }));
  } catch (err) {
    throw new Error(`Catalog lookup failed for MPN "${mpn}": ${(err as Error).message}`);
  }
}

/**
 * Verifies if the exact MPN exists and is in stock.
 */
export async function verifyMpn(mpn: string): Promise<{ status: MpnStatus; item?: CatalogItem; candidates?: CatalogItem[] }> {
  const trimmedMpn = mpn.trim();
  if (trimmedMpn.length === 0) {
    return { status: 'NOT FOUND' };
  }
  const items = await queryPartCatalog(trimmedMpn);
  const target = trimmedMpn.toLowerCase();
  const matched = items.find((item) => item.mfr.trim().toLowerCase() === target);
  if (!matched) {
    return { status: 'NOT FOUND', candidates: items.length > 0 ? items : undefined };
  }
  if (matched.stock <= 0) {
    return { status: 'NO STOCK', item: matched };
  }
  return { status: 'RESOLVED', item: matched };
}
