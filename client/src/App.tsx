import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

export interface Message {
  id: string;
  text: string;
  createdAt: string;
}

function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateBadge(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [draft, setDraft] = useState<string>("");
  const [isSending, setIsSending] = useState<boolean>(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadMessages = useCallback(async () => {
    setIsLoadingHistory(true);
    setHistoryError(null);

    try {
      const response = await fetch("/messages", {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        let errorDetail = `Server responded with HTTP ${response.status}.`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload?.error) {
            errorDetail = payload.error;
          }
        } catch {
          // Keep fallback HTTP status message if response is not JSON
        }
        throw new Error(errorDetail);
      }

      const data = (await response.json()) as Message[];
      setMessages(Array.isArray(data) ? data : []);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Unable to load message history from the server.";
      setHistoryError(
        `Could not load message history. ${message} Make sure the Express server is running on port 3000.`
      );
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSending) {
      return;
    }

    const submittedDraft = draft;
    setIsSending(true);
    setSendError(null);

    try {
      const response = await fetch("/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ text: submittedDraft }),
      });

      if (!response.ok) {
        let errorMessage = `Send failed with HTTP ${response.status}.`;
        try {
          const errorBody = (await response.json()) as { error?: string };
          if (errorBody?.error) {
            errorMessage = errorBody.error;
          }
        } catch {
          // Fallback to status message if proxy or server returned non-JSON
        }
        throw new Error(errorMessage);
      }

      const createdMessage = (await response.json()) as Message;

      // Append only after server confirmation and MongoDB write acknowledgment
      setMessages((prev) => [...prev, createdMessage]);
      // Clear the draft only if it still matches what was submitted; otherwise preserve user edits
      setDraft((currentDraft) =>
        currentDraft === submittedDraft ? "" : currentDraft
      );
      inputRef.current?.focus();
    } catch (err) {
      const detail =
        err instanceof Error
          ? err.message
          : "Network error while sending message.";
      setSendError(
        `Message could not be sent: ${detail} Your draft has been kept below so you can try again.`
      );
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="workspace-shell">
      <header className="workspace-header">
        <div className="brand-group">
          <div className="brand-mark" aria-hidden="true">
            TB
          </div>
          <div>
            <div className="eyebrow-row">
              <span className="workspace-eyebrow">THREADBOARD WORKSPACE</span>
              <span className="channel-pill">#general-stream</span>
            </div>
            <h1 className="workspace-title">Shared Engineering Log</h1>
          </div>
        </div>

        <div className="header-meta">
          <span className="message-counter" aria-live="polite">
            {messages.length} {messages.length === 1 ? "entry" : "entries"}
          </span>
          <button
            type="button"
            className="refresh-button"
            onClick={() => void loadMessages()}
            disabled={isLoadingHistory}
          >
            {isLoadingHistory ? "Syncing..." : "Refresh log"}
          </button>
        </div>
      </header>

      <main className="stream-panel" aria-label="Workspace message history">
        {isLoadingHistory ? (
          <div
            className="state-card state-loading"
            role="status"
            aria-live="polite"
          >
            <div className="spinner" aria-hidden="true" />
            <div>
              <p className="state-title">Loading message history...</p>
              <p className="state-subtitle">
                Fetching persisted entries from MongoDB via GET /messages.
              </p>
            </div>
          </div>
        ) : historyError ? (
          <div className="state-card state-error" role="alert">
            <div>
              <p className="state-title">Connection issue</p>
              <p className="state-subtitle">{historyError}</p>
            </div>
            <button
              type="button"
              className="retry-button"
              onClick={() => void loadMessages()}
            >
              Retry loading
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className="state-card state-empty" role="status">
            <p className="state-title">No messages in this stream yet</p>
            <p className="state-subtitle">
              Write the first note below to persist it to the workspace log.
            </p>
          </div>
        ) : (
          <ol className="message-ledger" aria-live="polite">
            {messages.map((msg, index) => (
              <li key={msg.id} className="ledger-entry">
                <div className="ledger-meta">
                  <span className="entry-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <time
                    className="entry-time"
                    dateTime={msg.createdAt}
                    title={msg.createdAt}
                  >
                    {formatDateBadge(msg.createdAt)} ·{" "}
                    {formatTimestamp(msg.createdAt)}
                  </time>
                  <span className="entry-id" title={`Message ID: ${msg.id}`}>
                    #{msg.id.slice(0, 8)}
                  </span>
                </div>
                <p className="ledger-text">{msg.text}</p>
              </li>
            ))}
          </ol>
        )}
        <div ref={streamEndRef} />
      </main>

      <footer className="composer-dock">
        {sendError && (
          <div
            id="composer-error"
            className="send-error-banner"
            role="alert"
            aria-live="assertive"
          >
            <span>{sendError}</span>
            <button
              type="button"
              className="dismiss-error-button"
              onClick={() => setSendError(null)}
              aria-label="Dismiss error message"
            >
              Dismiss
            </button>
          </div>
        )}

        <form className="composer-form" onSubmit={handleSubmit} noValidate>
          <div className="composer-field">
            <label htmlFor="message-input" className="composer-label">
              New workspace message
            </label>
            <div className="composer-control-row">
              <input
                ref={inputRef}
                id="message-input"
                name="text"
                type="text"
                className="composer-input"
                placeholder="Write an update for the team..."
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-invalid={sendError ? "true" : "false"}
                aria-describedby={
                  sendError ? "composer-error composer-hint" : "composer-hint"
                }
                autoComplete="off"
              />
              <button
                type="submit"
                className="send-button"
                disabled={isSending}
              >
                {isSending ? "Sending..." : "Send"}
              </button>
            </div>
            <p id="composer-hint" className="composer-hint">
              Messages are added to the log only after MongoDB confirms the
              write.
            </p>
          </div>
        </form>
      </footer>
    </div>
  );
}
