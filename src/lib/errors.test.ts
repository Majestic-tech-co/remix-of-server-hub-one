import { describe, expect, it } from "vitest";
import { friendlyError } from "./errors";

describe("friendlyError", () => {
  it("maps known auth errors to friendly text", () => {
    expect(friendlyError(new Error("Invalid login credentials"))).toBe("Incorrect email or password.");
    expect(friendlyError({ message: "Email not confirmed" })).toMatch(/confirm your email/i);
    expect(friendlyError(new Error("over_email_send_rate_limit"))).toMatch(/too many/i);
  });

  it("never leaks database internals", () => {
    const leaks = [
      'relation "public.servers" does not exist',
      "permission denied for table commands",
      'duplicate key value violates unique constraint "servers_agent_token_hash_key"',
      "at Object.get (index.js:40:61508)",
    ];
    for (const raw of leaks) {
      const out = friendlyError(new Error(raw));
      expect(out).toBe("Something went wrong. Please try again.");
      expect(out).not.toContain("public.");
      expect(out).not.toContain("constraint");
    }
  });

  it("handles non-error values", () => {
    expect(friendlyError(undefined)).toBe("Something went wrong. Please try again.");
    expect(friendlyError("boom")).toBe("Something went wrong. Please try again.");
  });
});
