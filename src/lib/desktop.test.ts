import { afterEach, describe, expect, it } from "vitest";
import { getDesktop } from "./desktop";

const g = globalThis as unknown as { window?: unknown };

describe("desktop app detection", () => {
  afterEach(() => { delete g.window; });

  it("is off on the server and in a normal browser", () => {
    expect(getDesktop()).toBeNull();                 // no window (server rendering)
    g.window = {};
    expect(getDesktop()).toBeNull();                 // a regular browser has no bridge
  });

  it("ignores look-alikes: wrong version or missing functions", () => {
    g.window = { fleetDesktop: { version: 2, ssh: { connect() {} } } };
    expect(getDesktop()).toBeNull();
    g.window = { fleetDesktop: { version: 1, ssh: {} } };
    expect(getDesktop()).toBeNull();
    g.window = { fleetDesktop: "yes" };
    expect(getDesktop()).toBeNull();
  });

  it("is on when the app's bridge is present", () => {
    const bridge = { version: 1, ssh: { connect() {} } };
    g.window = { fleetDesktop: bridge };
    expect(getDesktop()).toBe(bridge);
  });
});
