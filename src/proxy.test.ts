// src/proxy.test.ts
import { describe, expect, it } from "vitest";
import { isProtectedPath } from "./proxy";

describe("isProtectedPath", () => {
  it("protects /portfolio and nested paths", () => {
    expect(isProtectedPath("/portfolio")).toBe(true);
    expect(isProtectedPath("/portfolio/edit")).toBe(true);
  });

  it("protects /history and nested paths", () => {
    expect(isProtectedPath("/history")).toBe(true);
  });

  it("does not protect unrelated paths", () => {
    expect(isProtectedPath("/")).toBe(false);
    expect(isProtectedPath("/t/abc123")).toBe(false);
    expect(isProtectedPath("/portfolio-preview")).toBe(false);
  });
});
