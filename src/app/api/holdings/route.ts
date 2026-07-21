// src/app/api/holdings/route.ts
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { addHolding, deleteHolding, updateHolding } from "@/lib/db/holdings";

const addSchema = z.object({
  ticker: z.string().regex(/^\d{6}$/),
  name: z.string().min(1),
  quantity: z.number().positive(),
  buyPrice: z.number().positive(),
});
const updateSchema = z.object({
  id: z.string().min(1),
  quantity: z.number().positive(),
  buyPrice: z.number().positive(),
});

export async function POST(request: Request): Promise<Response> {
  const supabase = await createClient();
  const user = await getUser(supabase);
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });

  await addHolding(supabase, user.id, parsed.data);
  return Response.json({ ok: true });
}

export async function PATCH(request: Request): Promise<Response> {
  const supabase = await createClient();
  const user = await getUser(supabase);
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });

  await updateHolding(supabase, user.id, parsed.data.id, { quantity: parsed.data.quantity, buyPrice: parsed.data.buyPrice });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const supabase = await createClient();
  const user = await getUser(supabase);
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "invalid id" }, { status: 400 });

  await deleteHolding(supabase, user.id, id);
  return Response.json({ ok: true });
}
