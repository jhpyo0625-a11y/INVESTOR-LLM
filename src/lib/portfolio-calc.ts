export type PricedHolding = {
  ticker: string;
  name: string;
  quantity: number;
  buyPrice: number;
  currentPrice: number | null;
};

export type HoldingPL = { valueKrw: number | null; ratePct: number | null };

export function calculateHoldingPL(h: PricedHolding): HoldingPL {
  if (h.currentPrice === null) return { valueKrw: null, ratePct: null };
  const valueKrw = (h.currentPrice - h.buyPrice) * h.quantity;
  const costBasis = h.buyPrice * h.quantity;
  const ratePct = costBasis === 0 ? 0 : (valueKrw / costBasis) * 100;
  return { valueKrw, ratePct };
}
