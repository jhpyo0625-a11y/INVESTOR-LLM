import type { Listing } from "./listings";

export async function searchCompaniesRemote(query: string, signal?: AbortSignal): Promise<Listing[]> {
  const res = await fetch(`/api/listings?q=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
