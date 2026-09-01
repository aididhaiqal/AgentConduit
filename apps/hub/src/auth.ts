import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PRODUCTION_COOKIE = "__Host-agentconduit";
const DEVELOPMENT_COOKIE = "agentconduit_session";

interface StoredSession {
  tokenHash: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

export interface OwnerSession {
  csrfToken: string;
  expiresAt: string;
}

export interface OwnerLogin extends OwnerSession {
  cookie: string;
}

export interface OwnerSessionManagerOptions {
  ownerToken: string;
  secureCookies: boolean;
  sessionTtlMs?: number;
  clock?: () => number;
  random?: (bytes: number) => Buffer;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestMatches(leftDigest: string, rightDigest: string): boolean {
  const left = Buffer.from(leftDigest, "hex");
  const right = Buffer.from(rightDigest, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function secretMatches(provided: string, expected: string): boolean {
  return digestMatches(hash(provided), hash(expected));
}

function cookieValue(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    const value = entry.slice(separator + 1).trim();
    return value || undefined;
  }
  return undefined;
}

export class OwnerSessionManager {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly ownerToken: string;
  private readonly secureCookies: boolean;
  private readonly sessionTtlMs: number;
  private readonly clock: () => number;
  private readonly random: (bytes: number) => Buffer;

  constructor(options: OwnerSessionManagerOptions) {
    if (options.ownerToken.length < 32) {
      throw new Error("Owner token must contain at least 32 characters");
    }
    this.ownerToken = options.ownerToken;
    this.secureCookies = options.secureCookies;
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1_000;
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? randomBytes;
  }

  get cookieName(): string {
    return this.secureCookies ? PRODUCTION_COOKIE : DEVELOPMENT_COOKIE;
  }

  private prune(): void {
    const now = this.clock();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
    const excess = this.sessions.size - 16;
    if (excess <= 0) return;
    const oldest = [...this.sessions.entries()]
      .sort((left, right) => left[1].createdAt - right[1].createdAt)
      .slice(0, excess);
    for (const [key] of oldest) this.sessions.delete(key);
  }

  login(providedToken: string): OwnerLogin | undefined {
    this.prune();
    if (!secretMatches(providedToken, this.ownerToken)) return undefined;
    const token = `aos_${this.random(32).toString("hex")}`;
    const csrfToken = `aoc_${this.random(24).toString("hex")}`;
    const createdAt = this.clock();
    const expiresAt = createdAt + this.sessionTtlMs;
    this.sessions.set(hash(token), {
      tokenHash: hash(token),
      csrfToken,
      createdAt,
      expiresAt,
    });
    const attributes = [
      `${this.cookieName}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.max(1, Math.floor(this.sessionTtlMs / 1_000))}`,
      ...(this.secureCookies ? ["Secure"] : []),
    ];
    return {
      cookie: attributes.join("; "),
      csrfToken,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  session(cookieHeader: string | undefined): OwnerSession | undefined {
    this.prune();
    const token = cookieValue(cookieHeader, this.cookieName);
    if (!token || !/^aos_[0-9a-f]{64}$/.test(token)) return undefined;
    const tokenHash = hash(token);
    const stored = this.sessions.get(tokenHash);
    if (!stored || !digestMatches(tokenHash, stored.tokenHash))
      return undefined;
    return {
      csrfToken: stored.csrfToken,
      expiresAt: new Date(stored.expiresAt).toISOString(),
    };
  }

  authorize(
    cookieHeader: string | undefined,
    csrfToken: string | undefined,
  ): boolean {
    const session = this.session(cookieHeader);
    return Boolean(
      session && csrfToken && secretMatches(csrfToken, session.csrfToken),
    );
  }

  logout(cookieHeader: string | undefined): string {
    const token = cookieValue(cookieHeader, this.cookieName);
    if (token) this.sessions.delete(hash(token));
    return `${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${
      this.secureCookies ? "; Secure" : ""
    }`;
  }

  authorizeBearer(value: string | undefined): boolean {
    if (value?.slice(0, 7).toLowerCase() !== "bearer ") return false;
    return secretMatches(value.slice(7), this.ownerToken);
  }
}
