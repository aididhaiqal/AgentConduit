import { describe, expect, it } from "vitest";
import { OwnerSessionManager } from "../src/auth.js";

describe("owner browser sessions", () => {
  it("issues secure HttpOnly sessions, enforces CSRF, expires, and logs out", () => {
    let now = Date.parse("2026-09-01T00:00:00.000Z");
    let marker = 1;
    const sessions = new OwnerSessionManager({
      ownerToken: `aco_${"a".repeat(64)}`,
      secureCookies: true,
      sessionTtlMs: 60_000,
      clock: () => now,
      random: (bytes) => Buffer.alloc(bytes, marker++),
    });

    expect(sessions.login("wrong-token")).toBeUndefined();
    const login = sessions.login(`aco_${"a".repeat(64)}`)!;
    expect(login.cookie).toContain("__Host-agentconduit=aos_");
    expect(login.cookie).toContain("HttpOnly");
    expect(login.cookie).toContain("SameSite=Strict");
    expect(login.cookie).toContain("Secure");
    const cookie = login.cookie.split(";", 1)[0];

    expect(sessions.session(cookie)).toMatchObject({
      csrfToken: login.csrfToken,
    });
    expect(sessions.authorize(cookie, login.csrfToken)).toBe(true);
    expect(sessions.authorize(cookie, "aoc_" + "0".repeat(48))).toBe(false);

    const cleared = sessions.logout(cookie);
    expect(cleared).toContain("Max-Age=0");
    expect(sessions.session(cookie)).toBeUndefined();

    const expiring = sessions.login(`aco_${"a".repeat(64)}`)!;
    now += 60_001;
    expect(sessions.session(expiring.cookie)).toBeUndefined();
  });

  it("supports owner bearer authentication without weakening browser sessions", () => {
    const ownerToken = `aco_${"b".repeat(64)}`;
    const sessions = new OwnerSessionManager({
      ownerToken,
      secureCookies: false,
    });
    expect(sessions.authorizeBearer(`Bearer ${ownerToken}`)).toBe(true);
    expect(sessions.authorizeBearer(`bearer ${ownerToken}`)).toBe(true);
    expect(sessions.authorizeBearer("Bearer wrong")).toBe(false);
    expect(sessions.login(ownerToken)?.cookie).not.toContain("Secure");
  });
});
