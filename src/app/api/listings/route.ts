import { searchListings } from "@/lib/listings";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";
  return Response.json(searchListings(q));
}
