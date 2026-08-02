import { describe, it, expect } from "vitest";
import { renderReference, resolveReferencePath } from "./render-reference";

// ============================================================
// renderReference + resolveReferencePath — the small utility that
// turns a vars value into prompt-ready vocabulary text and resolves
// a `vars.x.y[0]` style path against the run context.
//
// Universal: pretty-prints objects, passes strings through, truncates
// oversized payloads. Path resolution mirrors `interpolate()`'s
// `vars.*` syntax so the same expression that works in `query_params`
// also works here.
// ============================================================

describe("renderReference", () => {
  it("returns empty string for null/undefined", () => {
    expect(renderReference(null)).toBe("")
    expect(renderReference(undefined)).toBe("")
  })

  it("returns empty string for an empty string", () => {
    expect(renderReference("")).toBe("")
  })

  it("passes non-empty strings through verbatim", () => {
    expect(renderReference("hello")).toBe("hello")
    expect(renderReference("multi\nline\ntext")).toBe("multi\nline\ntext")
  })

  it("stringifies numbers and booleans", () => {
    expect(renderReference(42)).toBe("42")
    expect(renderReference(true)).toBe("true")
    expect(renderReference(false)).toBe("false")
    expect(renderReference(0)).toBe("0")
  })

  it("pretty-prints objects and arrays", () => {
    const out = renderReference({ brands: ["Honda", "Toyota"] })
    expect(out).toMatch(/"brands":\s*\[\s*"Honda"/)
    expect(out).toContain("\n")
  })

  it("pretty-prints nested structures with indentation", () => {
    const out = renderReference({ a: { b: { c: 1 } } })
    expect(out).toContain('"a": {')
    expect(out).toContain('"b": {')
    expect(out).toContain('"c": 1')
  })

  it("truncates oversized payloads at the 8KB cap with a marker", () => {
    const huge = "x".repeat(12 * 1024)
    const out = renderReference(huge)
    expect(out.length).toBeLessThanOrEqual(8 * 1024 + 50) // marker
    expect(out).toContain("[truncated]")
  })

  it("does not append the truncation marker when the payload fits", () => {
    expect(renderReference("short text")).not.toContain("[truncated]")
  })

  it("truncates large objects/arrays too", () => {
    const huge = { data: "x".repeat(12 * 1024) }
    const out = renderReference(huge)
    expect(out).toContain("[truncated]")
  })

  it("falls back gracefully on values that can't be JSON-stringified", () => {
    // Circular reference — JSON.stringify throws, but the helper
    // should still return *something* (the String() fallback) rather
    // than crash the prompt builder.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => renderReference(circular)).not.toThrow()
    const out = renderReference(circular)
    expect(typeof out).toBe("string")
  })
})

describe("resolveReferencePath", () => {
  const vars = {
    webhook_response: {
      brands: ["Honda", "Toyota"],
      results: [
        { id: "p1", name: "Labial Matte" },
        { id: "p2", name: "Rimel Volumen" },
      ],
    },
    empty: null,
    list: [{ a: 1 }, { a: 2 }],
  }

  it("resolves a simple vars.* key", () => {
    expect(resolveReferencePath(vars, "vars.webhook_response")).toBe(vars.webhook_response)
  })

  it("strips a leading 'vars.' prefix", () => {
    expect(resolveReferencePath(vars, "vars.webhook_response")).toBe(vars.webhook_response)
  })

  it("resolves a nested path", () => {
    expect(resolveReferencePath(vars, "vars.webhook_response.brands")).toEqual(["Honda", "Toyota"])
  })

  it("resolves an indexed path", () => {
    expect(resolveReferencePath(vars, "vars.webhook_response.results[0].name")).toBe("Labial Matte")
    expect(resolveReferencePath(vars, "vars.webhook_response.results[1].id")).toBe("p2")
  })

  it("returns undefined for an empty or whitespace path", () => {
    expect(resolveReferencePath(vars, "")).toBeUndefined()
    expect(resolveReferencePath(vars, "   ")).toBeUndefined()
  })

  it("returns undefined for an unresolvable path", () => {
    expect(resolveReferencePath(vars, "vars.nonexistent")).toBeUndefined()
    expect(resolveReferencePath(vars, "vars.webhook_response.brands[99]")).toBeUndefined()
    expect(resolveReferencePath(vars, "vars.webhook_response.brands.foo")).toBeUndefined()
  })

  it("returns undefined for an empty vars root when the path is just 'vars'", () => {
    expect(resolveReferencePath({}, "vars")).toBeUndefined()
  })
})
