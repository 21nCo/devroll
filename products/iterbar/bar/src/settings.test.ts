import { describe, expect, it } from "vitest";
import { compareVersions } from "./settings.js";

describe("compareVersions", () => {
  it("orders versions by semver precedence", () => {
    expect(compareVersions("1.2.0", "1.1.0")).toBeGreaterThan(0);
    expect(compareVersions("1.1.0", "1.2.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
  });
});
