import "dotenv/config";
import { Collection, Db, MongoClient } from "mongodb";

export interface Message {
  id: string;
  text: string;
  createdAt: string;
}

const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  "mongodb://127.0.0.1:27017";

const MONGODB_DB_NAME =
  process.env.MONGODB_DB_NAME ||
  process.env.DB_NAME ||
  "collaborative_workspace";

const CONNECT_TIMEOUT_MS =
  Number(process.env.MONGODB_CONNECT_TIMEOUT_MS) || 5000;

// Single MongoClient instance reused across the server process
let client: MongoClient | null = null;
let database: Db | null = null;
let messagesCollection: Collection<Message> | null = null;

/**
 * Redacts credentials or connection strings from error messages before logging.
 */
export function sanitizeDbError(err: unknown): string {
  const rawMessage = err instanceof Error ? err.message : String(err);
  return rawMessage
    .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGODB_URI]")
    .replace(/\/\/([^:]+):([^@]+)@/g, "//[REDACTED_CREDENTIALS]@");
}

/**
 * Connects the shared MongoClient and verifies connectivity with a ping before
 * the HTTP server starts accepting requests.
 */
export async function connectToDatabase(): Promise<Collection<Message>> {
  if (messagesCollection) {
    return messagesCollection;
  }

  client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
  });

  await client.connect();
  database = client.db(MONGODB_DB_NAME);

  // Verify the connection is active before accepting HTTP traffic
  await database.command({ ping: 1 });

  messagesCollection = database.collection<Message>("messages");

  // Index to support oldest-first sorting with deterministic tie-breaking
  await messagesCollection.createIndex({ createdAt: 1, id: 1 });

  return messagesCollection;
}

export function getMessagesCollection(): Collection<Message> {
  if (!messagesCollection) {
    throw new Error("Database connection has not been initialized.");
  }
  return messagesCollection;
}

export async function closeDatabaseConnection(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    database = null;
    messagesCollection = null;
  }
}
