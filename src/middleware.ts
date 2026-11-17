import { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { toPublicUser } from "./auth";
import { getUsersCollection, sanitizeDbError } from "./db";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Protects state-changing routes from CSRF by checking Sec-Fetch-Site, Origin,
 * Referer, and requiring JSON content-type whenever a request carries a body.
 */
export function createOriginProtection(allowedOrigins: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const secFetchSite = req.get("sec-fetch-site");
    if (secFetchSite === "cross-site") {
      res.status(403).json({
        error: "Forbidden: Cross-site requests are not allowed.",
      });
      return;
    }

    const origin = req.get("origin");
    if (origin) {
      if (!allowedOrigins.has(origin)) {
        res.status(403).json({
          error: "Forbidden: Request origin is not allowed.",
        });
        return;
      }
    } else {
      const referer = req.get("referer");
      if (referer) {
        try {
          const refererOrigin = new URL(referer).origin;
          if (!allowedOrigins.has(refererOrigin)) {
            res.status(403).json({
              error: "Forbidden: Request referer origin is not allowed.",
            });
            return;
          }
        } catch {
          res.status(403).json({
            error: "Forbidden: Invalid request referer.",
          });
          return;
        }
      }
    }

    // Disallow non-JSON payloads (such as simple HTML form submissions)
    const contentType = req.get("content-type");
    if (contentType && !req.is("application/json")) {
      res.status(415).json({
        error: "Unsupported Media Type: Expected application/json.",
      });
      return;
    }

    next();
  };
}

export function createAuthRateLimiter(options: {
  windowMs?: number;
  max?: number;
} = {}) {
  return rateLimit({
    windowMs: options.windowMs ?? 15 * 60 * 1000,
    limit: options.max ?? 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Too many authentication attempts. Please try again later.",
    },
  });
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({
      error: "Authentication required. Please sign in.",
    });
    return;
  }

  try {
    const users = getUsersCollection();
    const user = await users.findOne({ id: userId });

    if (!user) {
      req.session.destroy(() => {
        res.status(401).json({
          error: "Session is no longer valid. Please sign in again.",
        });
      });
      return;
    }

    req.currentUser = toPublicUser(user);
    next();
  } catch (err) {
    console.error("Failed to verify session user:", sanitizeDbError(err));
    res.status(500).json({
      error: "Database error: Unable to verify authentication session.",
    });
  }
}
