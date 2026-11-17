import "dotenv/config";
import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import {
  closeDatabaseConnection,
  connectToDatabase,
  getMessagesCollection,
  Message,
  sanitizeDbError,
} from "./db";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// GET /messages - return all stored messages oldest first with a deterministic tie-breaker
app.get("/messages", async (_req: Request, res: Response) => {
  try {
    const collection = getMessagesCollection();
    const docs = await collection
      .find({}, { projection: { _id: 0, id: 1, text: 1, createdAt: 1 } })
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

// POST /messages - validate, persist in MongoDB, and return 201 after acknowledgment
app.post("/messages", async (req: Request, res: Response) => {
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

  const newMessage: Message = {
    id: randomUUID(),
    text,
    createdAt: new Date().toISOString(),
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

async function startServer(): Promise<void> {
  try {
    await connectToDatabase();
    console.log("Connected to MongoDB and verified database ping.");

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
