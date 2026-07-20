import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerTools, runTool } from "./index";
import type { Tool } from "./types";

const echo: Tool = {
  name: "echo",
  description: "echoes",
  schema: z.object({ msg: z.string() }),
  run: async (args) => ({ ok: true, data: args }),
};
const boom: Tool = {
  name: "boom",
  description: "throws",
  schema: z.object({}),
  run: async () => {
    throw new Error("kaput");
  },
};

describe("runTool", () => {
  registerTools([echo, boom]);
  it("runs a tool with valid args", async () => {
    expect(await runTool("echo", { msg: "hi" })).toEqual({ ok: true, data: { msg: "hi" } });
  });
  it("rejects invalid args without throwing", async () => {
    const r = await runTool("echo", { msg: 42 });
    expect(r.ok).toBe(false);
  });
  it("converts thrown errors to ToolResult", async () => {
    expect(await runTool("boom", {})).toEqual({ ok: false, error: "kaput" });
  });
  it("handles unknown tool", async () => {
    const r = await runTool("nope", {});
    expect(r.ok).toBe(false);
  });
});
