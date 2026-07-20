import { unzipSync, strFromU8 } from "fflate";
import { writeFileSync, mkdirSync } from "node:fs";

async function main() {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error("DART_API_KEY missing");
  const res = await fetch(
    `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${key}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) throw new Error(`DART corpCode HTTP ${res.status}`);
  const zip = new Uint8Array(await res.arrayBuffer());
  const xml = strFromU8(unzipSync(zip)["CORPCODE.xml"]);

  const listings = [...xml.matchAll(/<list>([\s\S]*?)<\/list>/g)]
    .map((m) => {
      const g = (tag: string) =>
        m[1].match(new RegExp(`<${tag}>(.*?)</${tag}>`))?.[1]?.trim() ?? "";
      return { name: g("corp_name"), ticker: g("stock_code"), corpCode: g("corp_code") };
    })
    .filter((c) => /^\d{6}$/.test(c.ticker));

  mkdirSync("data", { recursive: true });
  writeFileSync("data/listings.json", JSON.stringify(listings), "utf8");
  console.log(`wrote data/listings.json: ${listings.length} listed companies`);
}
main();
