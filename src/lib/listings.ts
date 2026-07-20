import raw from "../../data/listings.json";

export type Listing = { name: string; ticker: string; corpCode: string };

const listings = raw as Listing[];

export function searchListings(q: string, limit = 8): Listing[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  return listings
    .filter((c) => c.name.toLowerCase().includes(query) || c.ticker.startsWith(query))
    .slice(0, limit);
}

export function findByTicker(ticker: string): Listing | undefined {
  return listings.find((c) => c.ticker === ticker);
}
