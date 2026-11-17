import MongoStore from "connect-mongo";
import express, { Express, Request, Response } from "express";
import session from "express-session";
import { MongoServerError } from "mongodb";
import { randomUUID } from "node:crypto";
import {
  hashPassword,
  toPublicUser,
  validateLoginInput,
  validateRegistrationInput,
  verifyPassword,
} from "./auth";
import {
  getDatabase,
  getMessagesCollection,
  getMongoClient,
  getUsersCollection,
  Message,
  sanitizeDbError,
  UserDocument,
} from "./db";
import {
  createAuthRateLimiter,
  createOriginProtection,
  requireAuth,
} from "./middleware";

export const SESSION_COOKIE_NAME = "threadboard.sid";

export interface CreateAppOptions {
  sessionSecret: string;
  sessionTtlMs?: number;
  isProduction?: boolean;
  allowedOrigins?: string[];
  authRateLimitWindowMs?: number;
  authRateLimitMax?: number;
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export function createApp(options: CreateAppOptions): Express {
  const {
    sessionSecret,
    sessionTtlMs = 7 * 24 * 60 * 60 * 1000,
    isProduction = process.env.NODE_ENV === "production",
    allowedOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"],
    authRateLimitWindowMs,
    authRateLimitMax,
  } = options;

  if (!sessionSecret || sessionSecret.trim().length === 0) {
    throw new Error("SESSION_SECRET environment variable is required.");
  }

  const app = express();

  if (isProduction) {
    app.set("trust proxy", 1);
  }

  app.use(express.json());

  const originSet = new Set(allowedOrigins.map((origin) => origin.trim()));
  app.use(createOriginProtection(originSet));

  const sessionStore = MongoStore.create({
    client: getMongoClient(),
    dbName: getDatabase().databaseName,
    collectionName: "sessions",
    ttl: Math.max(1, Math.ceil(sessionTtlMs / 1000)),
  });

  app.use(
    session({
      name: SESSION_COOKIE_NAME,
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      store: sessionStore,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: isProduction,
        maxAge: sessionTtlMs,
        path: "/",
      },
    })
  );

  const authRateLimiter = createAuthRateLimiter({
    windowMs: authRateLimitWindowMs,
    max: authRateLimitMax,
  });

  // POST /auth/register - register a new user, enforce unique normalized email, and start a fresh session
  app.post(
    "/auth/register",
    authRateLimiter,
    async (req: Request, res: Response) => {
      const validation = validateRegistrationInput(req.body);
      if (!validation.ok) {
        res.status(400).json({ error: validation.error });
        return;
      }

      const { displayName, email, password } = validation.data;

      try {
        const users = getUsersCollection();
        const passwordHash = await hashPassword(password);

        const newUser: UserDocument = {
          id: randomUUID(),
          displayName,
          email,
          passwordHash,
          createdAt: new Date().toISOString(),
        };

        await users.insertOne({ ...newUser }, { writeConcern: { w: 1 } });

        await regenerateSession(req);
        req.session.userId = newUser.id;
        await saveSession(req);

        res.status(201).json({ user: toPublicUser(newUser) });
      } catch (err) {
        if (err instanceof MongoServerError && err.code === 11000) {
          res.status(409).json({
            error: "An account with this email already exists.",
          });
          return;
        }

        console.error("Failed to register user:", sanitizeDbError(err));
        res.status(500).json({
          error: "Unable to create account right now. Please try again.",
        });
      }
    }
  );

  // POST /auth/login - authenticate user, regenerate session, and issue session cookie
  app.post(
    "/auth/login",
    authRateLimiter,
    async (req: Request, res: Response) => {
      const validation = validateLoginInput(req.body);
      if (!validation.ok) {
        res.status(400).json({ error: validation.error });
        return;
      }

      const { email, password } = validation.data;

      try {
        const users = getUsersCollection();
        const user = await users.findOne({ email });

        if (!user || !(await verifyPassword(user.passwordHash, password))) {
          res.status(401).json({
            error: "Invalid email or password.",
          });
          return;
        }

        await regenerateSession(req);
        req.session.userId = user.id;
        await saveSession(req);

        res.json({ user: toPublicUser(user) });
      } catch (err) {
        console.error("Failed to log in user:", sanitizeDbError(err));
        res.status(500).json({
          error: "Unable to sign in right now. Please try again.",
        });
      }
    }
  );

  // POST /auth/logout - destroy server session and clear session cookie
  app.post("/auth/logout", async (req: Request, res: Response) => {
    try {
      if (req.session) {
        await destroySession(req);
      }
      res.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        sameSite: "lax",
        secure: isProduction,
        path: "/",
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("Failed to log out user:", sanitizeDbError(err));
      res.status(500).json({
        error: "Unable to log out right now.",
      });
    }
  });

  // GET /auth/me - return the authenticated user from the current session
  app.get("/auth/me", requireAuth, (req: Request, res: Response) => {
    res.json({ user: req.currentUser });
  });

  // GET /messages - authenticated message history, preserving legacy records as-is
  app.get("/messages", requireAuth, async (_req: Request, res: Response) => {
    try {
      const collection = getMessagesCollection();
      const docs = await collection
        .find(
          {},
          {
            projection: {
              _id: 0,
              id: 1,
              text: 1,
              createdAt: 1,
              userId: 1,
              authorName: 1,
            },
          }
        )
        .sort({ createdAt: 1, id: 1 })
        .toArray();

      res.json(docs);
    } catch (err) {
      console.error("Failed to fetch messages:", sanitizeDbError(err));
      res.status(500).json({
        error: "Database error: Unable to retrieve messages.",
      });
    }
  });

  // POST /messages - authenticated create; derives userId strictly from session
  app.post("/messages", requireAuth, async (req: Request, res: Response) => {
    const rawText = req.body?.text;

    if (typeof rawText !== "string") {
      res.status(400).json({
        error: "Invalid input: 'text' field is required and must be a string.",
      });
      return;
    }

    const text = rawText.trim();

    if (!text) {
      res.status(400).json({
        error: "Invalid input: 'text' cannot be empty or blank.",
      });
      return;
    }

    const authenticatedUser = req.currentUser;
    if (!authenticatedUser) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const newMessage: Message = {
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
      userId: authenticatedUser.id,
      authorName: authenticatedUser.displayName,
    };

    try {
      const collection = getMessagesCollection();
      const result = await collection.insertOne(
        { ...newMessage },
        { writeConcern: { w: 1 } }
      );

      if (!result.acknowledged) {
        res.status(500).json({
          error: "Database error: Message write was not acknowledged.",
        });
        return;
      }

      res.status(201).json(newMessage);
    } catch (err) {
      console.error("Failed to insert message:", sanitizeDbError(err));
      res.status(500).json({
        error: "Database error: Unable to save message.",
      });
    }
  });

  return app;
}
