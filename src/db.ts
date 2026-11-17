import "dotenv/config";
import { Collection, Db, MongoClient } from "mongodb";

export interface Message {
  id: string;
  text: string;
  createdAt: string;
  userId?: string;
  authorName?: string;
}

export interface UserDocument {
  id: string;
  displayName: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface ConnectDatabaseOptions {
  uri?: string;
  dbName?: string;
  connectTimeoutMs?: number;
}

const DEFAULT_MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  "mongodb://127.0.0.1:27017";

const DEFAULT_MONGODB_DB_NAME =
  process.env.MONGODB_DB_NAME ||
  process.env.DB_NAME ||
  "collaborative_workspace";

const DEFAULT_CONNECT_TIMEOUT_MS =
  Number(process.env.MONGODB_CONNECT_TIMEOUT_MS) || 5000;

// Single MongoClient instance reused across the server process
let client: MongoClient | null = null;
let database: Db | null = null;
let messagesCollection: Collection<Message> | null = null;
let usersCollection: Collection<UserDocument> | null = null;

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
 * Connects the shared MongoClient, verifies connectivity with a ping, and ensures
 * required indexes exist before the HTTP server starts accepting requests.
 */
export async function connectToDatabase(
  options: ConnectDatabaseOptions = {}
): Promise<{
  client: MongoClient;
  database: Db;
  messages: Collection<Message>;
  users: Collection<UserDocument>;
}> {
  if (client && database && messagesCollection && usersCollection) {
    return {
      client,
      database,
      messages: messagesCollection,
      users: usersCollection,
    };
  }

  const uri = options.uri ?? DEFAULT_MONGODB_URI;
  const dbName = options.dbName ?? DEFAULT_MONGODB_DB_NAME;
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: connectTimeoutMs,
    connectTimeoutMS: connectTimeoutMs,
  });

  await client.connect();
  database = client.db(dbName);

  // Verify the connection is active before accepting HTTP traffic
  await database.command({ ping: 1 });

  messagesCollection = database.collection<Message>("messages");
  usersCollection = database.collection<UserDocument>("users");

  // Index to support oldest-first sorting with deterministic tie-breaking
  await messagesCollection.createIndex({ createdAt: 1, id: 1 });

  // Enforce normalized email uniqueness at the database level
  await usersCollection.createIndex({ email: 1 }, { unique: true });
  await usersCollection.createIndex({ id: 1 }, { unique: true });

  return {
    client,
    database,
    messages: messagesCollection,
    users: usersCollection,
  };
}

export function getMongoClient(): MongoClient {
  if (!client) {
    throw new Error("Database client has not been initialized.");
  }
  return client;
}

export function getDatabase(): Db {
  if (!database) {
    throw new Error("Database connection has not been initialized.");
  }
  return database;
}

export function getMessagesCollection(): Collection<Message> {
  if (!messagesCollection) {
    throw new Error("Database connection has not been initialized.");
  }
  return messagesCollection;
}

export function getUsersCollection(): Collection<UserDocument> {
  if (!usersCollection) {
    throw new Error("Database connection has not been initialized.");
  }
  return usersCollection;
}

export async function closeDatabaseConnection(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    database = null;
    messagesCollection = null;
    usersCollection = null;
  }
}
