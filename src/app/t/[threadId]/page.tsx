// src/app/t/[threadId]/page.tsx
import { ChatThread } from "@/components/ChatThread";

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<{ mode?: string; target?: string; option?: string }>;
}) {
  const { threadId } = await params;
  const sp = await searchParams;
  const mode = sp.mode === "date" ? "date" : "company";
  const option = (["A", "B", "C", "D"].includes(sp.option ?? "") ? sp.option : "A") as
    | "A"
    | "B"
    | "C"
    | "D";
  const target = sp.target ?? "";

  return (
    <main className="flex flex-1 flex-col">
      <ChatThread threadId={threadId} initial={{ mode, target, option }} />
    </main>
  );
}
