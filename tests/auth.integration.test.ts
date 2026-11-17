import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp, CreateAppOptions, SESSION_COOKIE_NAME } from "../src/app";
import {
  closeDatabaseConnection,
  connectToDatabase,
  getDatabase,
  getMessagesCollection,
  getUsersCollection,
} from "../src/db";

const TEST_MONGODB_URI =
  process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017";
const TEST_DB_NAME =
  process.env.TEST_MONGODB_DB_NAME ||
  `collaborative_workspace_auth_test_${process.pid}`;
const TEST_SESSION_SECRET = "test-session-secret-for-integration-suite-32chars";

async function startTestServer(
  overrides: Partial<CreateAppOptions> = {}
): Promise<{ server: Server; baseUrl: string }> {
  const app = createApp({
    sessionSecret: TEST_SESSION_SECRET,
    authRateLimitMax: 100,
    ...overrides,
  });

  const server = await new Promise<Server>((resolve) => {
    const httpServer = app.listen(0, "127.0.0.1", () => resolve(httpServer));
  });

  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function extractSessionCookie(response: Response): string {
  const rawCookies = response.headers.getSetCookie();
  const match = rawCookies.find((cookie) =>
    cookie.startsWith(`${SESSION_COOKIE_NAME}=`)
  );
  assert.ok(match, "Expected session cookie in Set-Cookie header");
  return match.split(";")[0];
}

describe("Threadboard authentication & protected messaging integration", () => {
  before(async () => {
    await connectToDatabase({
      uri: TEST_MONGODB_URI,
      dbName: TEST_DB_NAME,
    });
  });

  beforeEach(async () => {
    const db = getDatabase();
    await getUsersCollection().deleteMany({});
    await getMessagesCollection().deleteMany({});
    await db.collection("sessions").deleteMany({});
  });

  after(async () => {
    try {
      await getDatabase().dropDatabase();
    } finally {
      await closeDatabaseConnection();
    }
  });

  it("registers a user, normalizes email, hashes password, and excludes passwordHash from responses", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "  Ada Lovelace  ",
          email: "  ADA@Threadboard.Dev ",
          password: "correct-horse-battery-staple",
        }),
      });

      assert.equal(res.status, 201);
      const setCookie = res.headers.getSetCookie().join("; ");
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);

      const cookie = extractSessionCookie(res);
      const body = (await res.json()) as { user: Record<string, unknown> };

      assert.equal(body.user.displayName, "Ada Lovelace");
      assert.equal(body.user.email, "ada@threadboard.dev");
      assert.equal("passwordHash" in body.user, false);
      assert.equal("password" in body.user, false);

      // Verify stored user hash uses Argon2id and current-user endpoint restores session
      const storedUser = await getUsersCollection().findOne({
        email: "ada@threadboard.dev",
      });
      assert.ok(storedUser);
      assert.match(storedUser.passwordHash, /^\$argon2id\$/);

      const meRes = await fetch(`${baseUrl}/auth/me`, {
        headers: { Cookie: cookie },
      });
      assert.equal(meRes.status, 200);
      const meBody = (await meRes.json()) as { user: Record<string, unknown> };
      assert.equal(meBody.user.id, body.user.id);
      assert.equal("passwordHash" in meBody.user, false);
    } finally {
      await stopTestServer(server);
    }
  });

  it("rejects duplicate and concurrent duplicate registrations with 409", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const payload = {
        displayName: "Grace Hopper",
        email: "grace@threadboard.dev",
        password: "compiler-pioneer-1952",
      };

      // Concurrent duplicate registration race
      const [r1, r2] = await Promise.all([
        fetch(`${baseUrl}/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
        fetch(`${baseUrl}/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...payload,
            email: "GRACE@THREADBOARD.DEV",
          }),
        }),
      ]);

      const statuses = [r1.status, r2.status].sort();
      assert.deepEqual(statuses, [201, 409]);

      // Sequential duplicate registration
      const r3 = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(r3.status, 409);
    } finally {
      await stopTestServer(server);
    }
  });

  it("rejects incorrect passwords with 401 and allows valid login", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Alan Turing",
          email: "alan@threadboard.dev",
          password: "enigma-breaker-1940",
        }),
      });

      const badLogin = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "alan@threadboard.dev",
          password: "wrong-password",
        }),
      });
      assert.equal(badLogin.status, 401);

      const goodLogin = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "  ALAN@Threadboard.Dev ",
          password: "enigma-breaker-1940",
        }),
      });
      assert.equal(goodLogin.status, 200);
      extractSessionCookie(goodLogin);
    } finally {
      await stopTestServer(server);
    }
  });

  it("blocks unauthenticated message access, preserves legacy messages, and ignores forged sender IDs", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      // Unauthenticated GET and POST must return 401
      const unauthGet = await fetch(`${baseUrl}/messages`);
      assert.equal(unauthGet.status, 401);

      const unauthPost = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Unauthorized message" }),
      });
      assert.equal(unauthPost.status, 401);

      // Seed a legacy message without userId or authorName
      const legacyId = randomUUID();
      const legacyCreatedAt = "2026-01-01T00:00:00.000Z";
      await getMessagesCollection().insertOne({
        id: legacyId,
        text: "Legacy message before auth",
        createdAt: legacyCreatedAt,
      });

      // Register authenticated user
      const regRes = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Linus Torvalds",
          email: "linus@threadboard.dev",
          password: "kernel-maintainer-91",
        }),
      });
      assert.equal(regRes.status, 201);
      const cookie = extractSessionCookie(regRes);
      const { user } = (await regRes.json()) as {
        user: { id: string; displayName: string };
      };

      // Attempt to forge userId / authorName in POST /messages
      const postRes = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({
          text: "  Authenticated note  ",
          userId: "forged-user-id",
          senderId: "forged-sender-id",
          authorName: "Forged Author",
        }),
      });
      assert.equal(postRes.status, 201);
      const created = (await postRes.json()) as {
        id: string;
        text: string;
        createdAt: string;
        userId?: string;
        authorName?: string;
      };

      assert.equal(created.text, "Authenticated note");
      assert.equal(created.userId, user.id);
      assert.equal(created.authorName, "Linus Torvalds");

      // Confirm legacy message is preserved untouched alongside new message
      const listRes = await fetch(`${baseUrl}/messages`, {
        headers: { Cookie: cookie },
      });
      assert.equal(listRes.status, 200);
      const list = (await listRes.json()) as Array<Record<string, unknown>>;
      assert.equal(list.length, 2);

      assert.deepEqual(list[0], {
        id: legacyId,
        text: "Legacy message before auth",
        createdAt: legacyCreatedAt,
      });
      assert.equal(list[1].userId, user.id);
      assert.equal(list[1].authorName, "Linus Torvalds");
    } finally {
      await stopTestServer(server);
    }
  });

  it("persists sessions across an Express server restart", async () => {
    let firstServer = await startTestServer();
    let cookie = "";
    let userId = "";

    try {
      const regRes = await fetch(`${firstServer.baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Margaret Hamilton",
          email: "margaret@threadboard.dev",
          password: "apollo-flight-software",
        }),
      });
      assert.equal(regRes.status, 201);
      cookie = extractSessionCookie(regRes);
      const body = (await regRes.json()) as { user: { id: string } };
      userId = body.user.id;
    } finally {
      await stopTestServer(firstServer.server);
    }

    // Start a fresh Express instance against the same MongoDB database
    const restartedServer = await startTestServer();
    try {
      const meRes = await fetch(`${restartedServer.baseUrl}/auth/me`, {
        headers: { Cookie: cookie },
      });
      assert.equal(meRes.status, 200);
      const meBody = (await meRes.json()) as { user: { id: string } };
      assert.equal(meBody.user.id, userId);

      const postRes = await fetch(`${restartedServer.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ text: "Sent after Express restart" }),
      });
      assert.equal(postRes.status, 201);
    } finally {
      await stopTestServer(restartedServer.server);
    }
  });

  it("enforces session expiry on the server", async () => {
    const { server, baseUrl } = await startTestServer({
      sessionTtlMs: 250,
    });

    try {
      const regRes = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Tim Berners-Lee",
          email: "timbl@threadboard.dev",
          password: "world-wide-web-1989",
        }),
      });
      assert.equal(regRes.status, 201);
      const cookie = extractSessionCookie(regRes);

      const immediateMe = await fetch(`${baseUrl}/auth/me`, {
        headers: { Cookie: cookie },
      });
      assert.equal(immediateMe.status, 200);

      await new Promise((resolve) => setTimeout(resolve, 350));

      const expiredMe = await fetch(`${baseUrl}/auth/me`, {
        headers: { Cookie: cookie },
      });
      assert.equal(expiredMe.status, 401);

      const expiredMessages = await fetch(`${baseUrl}/messages`, {
        headers: { Cookie: cookie },
      });
      assert.equal(expiredMessages.status, 401);
    } finally {
      await stopTestServer(server);
    }
  });

  it("destroys the session on logout and invalidates the old cookie", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const regRes = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Barbara Liskov",
          email: "barbara@threadboard.dev",
          password: "substitution-principle",
        }),
      });
      assert.equal(regRes.status, 201);
      const oldCookie = extractSessionCookie(regRes);

      const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
        headers: { Cookie: oldCookie },
      });
      assert.equal(logoutRes.status, 200);

      const meAfterLogout = await fetch(`${baseUrl}/auth/me`, {
        headers: { Cookie: oldCookie },
      });
      assert.equal(meAfterLogout.status, 401);

      const msgAfterLogout = await fetch(`${baseUrl}/messages`, {
        headers: { Cookie: oldCookie },
      });
      assert.equal(msgAfterLogout.status, 401);
    } finally {
      await stopTestServer(server);
    }
  });

  it("enforces origin protection and auth rate limiting", async () => {
    const { server, baseUrl } = await startTestServer({
      authRateLimitMax: 2,
      authRateLimitWindowMs: 60_000,
    });

    try {
      const crossOriginRes = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          email: "nobody@threadboard.dev",
          password: "password123",
        }),
      });
      assert.equal(crossOriginRes.status, 403);

      // Rate limiter allows 2 attempts and blocks the 3rd with 429
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${baseUrl}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "nobody@threadboard.dev",
            password: "password123",
          }),
        });
        assert.equal(res.status, 401);
      }

      const limitedRes = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "nobody@threadboard.dev",
          password: "password123",
        }),
      });
      assert.equal(limitedRes.status, 429);
    } finally {
      await stopTestServer(server);
    }
  });
});
