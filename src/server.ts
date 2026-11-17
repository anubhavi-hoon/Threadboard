import "dotenv/config";
import { createApp } from "./app";
import {
  closeDatabaseConnection,
  connectToDatabase,
  sanitizeDbError,
} from "./db";

const PORT = Number(process.env.PORT) || 3000;

function parseAllowedOrigins(port: number): string[] {
  const configured = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return Array.from(
    new Set([
      ...configured,
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
    ])
  );
}

async function startServer(): Promise<void> {
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (!sessionSecret) {
    console.error(
      "Startup failed: SESSION_SECRET environment variable is required."
    );
    process.exit(1);
  }

  const sessionTtlMs =
    Number(process.env.SESSION_TTL_MS) || 7 * 24 * 60 * 60 * 1000;
  const authRateLimitMax = Number(process.env.AUTH_RATE_LIMIT_MAX) || 20;

  try {
    await connectToDatabase();
    console.log("Connected to MongoDB and verified database ping.");

    const app = createApp({
      sessionSecret,
      sessionTtlMs,
      allowedOrigins: parseAllowedOrigins(PORT),
      authRateLimitMax,
    });

    const server = app.listen(PORT, () => {
      console.log(`Server is running at http://localhost:${PORT}`);
    });

    const shutdown = async () => {
      server.close(async () => {
        await closeDatabaseConnection();
        process.exit(0);
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    console.error(
      "Startup failed: Could not connect to MongoDB.",
      sanitizeDbError(err)
    );
    await closeDatabaseConnection().catch(() => {});
    process.exit(1);
  }
}

startServer();
