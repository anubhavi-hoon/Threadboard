import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

export interface User {
  id: string;
  displayName: string;
  email: string;
  createdAt: string;
}

export interface Message {
  id: string;
  text: string;
  createdAt: string;
  userId?: string;
  authorName?: string;
}

type AuthMode = "login" | "register";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

async function extractErrorMessage(
  response: Response,
  fallback: string
): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload?.error) {
      return payload.error;
    }
  } catch {
    // Keep fallback if response body is not JSON
  }
  return fallback;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState<boolean>(true);
  const [authMode, setAuthMode] = useState<AuthMode>("login");

  const [displayName, setDisplayName] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [isSubmittingAuth, setIsSubmittingAuth] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  const [isLoggingOut, setIsLoggingOut] = useState<boolean>(false);

  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [draft, setDraft] = useState<string>("");
  const [isSending, setIsSending] = useState<boolean>(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleSessionExpired = useCallback(() => {
    setUser(null);
    setMessages([]);
    setHistoryError(null);
    setSendError(null);
    setDraft("");
    setAuthMode("login");
    setAuthError(null);
    setSessionNotice("Your session expired. Please sign in again to continue.");
  }, []);

  const loadMessages = useCallback(async () => {
    setIsLoadingHistory(true);
    setHistoryError(null);

    try {
      const response = await fetch("/messages", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });

      if (response.status === 401) {
        handleSessionExpired();
        return;
      }

      if (!response.ok) {
        const errorDetail = await extractErrorMessage(
          response,
          `Server responded with HTTP ${response.status}.`
        );
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
  }, [handleSessionExpired]);

  // Restore authenticated user session on initial page load
  useEffect(() => {
    let active = true;

    async function restoreSession() {
      try {
        const response = await fetch("/auth/me", {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "same-origin",
        });

        if (!active) {
          return;
        }

        if (response.status === 401) {
          setUser(null);
          return;
        }

        if (!response.ok) {
          const errorDetail = await extractErrorMessage(
            response,
            `Server responded with HTTP ${response.status}.`
          );
          throw new Error(errorDetail);
        }

        const payload = (await response.json()) as { user: User };
        setUser(payload.user);
      } catch (err) {
        if (!active) {
          return;
        }
        const detail =
          err instanceof Error
            ? err.message
            : "Unable to verify current session.";
        setAuthError(
          `Could not reach the authentication server. ${detail}`
        );
      } finally {
        if (active) {
          setIsCheckingAuth(false);
        }
      }
    }

    void restoreSession();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (user) {
      void loadMessages();
    }
  }, [user, loadMessages]);

  useEffect(() => {
    if (user) {
      streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [user, messages.length]);

  const switchAuthMode = (nextMode: AuthMode) => {
    if (isSubmittingAuth) {
      return;
    }
    setAuthMode(nextMode);
    setAuthError(null);
  };

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmittingAuth) {
      return;
    }

    setAuthError(null);
    setSessionNotice(null);

    const normalizedEmail = email.trim().toLowerCase();
    const trimmedName = displayName.trim();

    if (authMode === "register") {
      if (trimmedName.length < 2 || trimmedName.length > 50) {
        setAuthError("Display name must be between 2 and 50 characters.");
        return;
      }
    }

    if (!normalizedEmail || !EMAIL_PATTERN.test(normalizedEmail)) {
      setAuthError("Please enter a valid email address.");
      return;
    }

    if (authMode === "register" && password.length < 8) {
      setAuthError("Password must be at least 8 characters long.");
      return;
    }

    if (authMode === "login" && password.length === 0) {
      setAuthError("Please enter your password.");
      return;
    }

    setIsSubmittingAuth(true);

    try {
      const endpoint =
        authMode === "register" ? "/auth/register" : "/auth/login";
      const body =
        authMode === "register"
          ? { displayName: trimmedName, email: normalizedEmail, password }
          : { email: normalizedEmail, password };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorMessage = await extractErrorMessage(
          response,
          `Authentication failed with HTTP ${response.status}.`
        );
        throw new Error(errorMessage);
      }

      const payload = (await response.json()) as { user: User };
      setUser(payload.user);
      setPassword("");
      setDisplayName("");
      setAuthError(null);
      setSessionNotice(null);
    } catch (err) {
      const detail =
        err instanceof Error
          ? err.message
          : "Network error while signing in.";
      setAuthError(detail);
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  const handleLogout = async () => {
    if (isLoggingOut) {
      return;
    }

    setIsLoggingOut(true);

    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });

      if (!response.ok) {
        const detail = await extractErrorMessage(
          response,
          `Logout failed with HTTP ${response.status}.`
        );
        throw new Error(detail);
      }

      setUser(null);
      setMessages([]);
      setDraft("");
      setSendError(null);
      setHistoryError(null);
      setAuthError(null);
      setSessionNotice(null);
      setAuthMode("login");
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : "Unable to log out right now.";
      setSendError(`Logout failed: ${detail}`);
    } finally {
      setIsLoggingOut(false);
    }
  };

  const handleMessageSubmit = async (event: FormEvent<HTMLFormElement>) => {
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
        credentials: "same-origin",
        body: JSON.stringify({ text: submittedDraft }),
      });

      if (response.status === 401) {
        handleSessionExpired();
        return;
      }

      if (!response.ok) {
        const errorMessage = await extractErrorMessage(
          response,
          `Send failed with HTTP ${response.status}.`
        );
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

  if (isCheckingAuth) {
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
              </div>
              <h1 className="workspace-title">Shared Engineering Log</h1>
            </div>
          </div>
        </header>
        <main className="stream-panel">
          <div
            className="state-card state-loading"
            role="status"
            aria-live="polite"
          >
            <div className="spinner" aria-hidden="true" />
            <div>
              <p className="state-title">Checking session...</p>
              <p className="state-subtitle">
                Verifying your sign-in status with the server.
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="workspace-shell auth-shell">
        <header className="workspace-header">
          <div className="brand-group">
            <div className="brand-mark" aria-hidden="true">
              TB
            </div>
            <div>
              <div className="eyebrow-row">
                <span className="workspace-eyebrow">THREADBOARD WORKSPACE</span>
                <span className="channel-pill">Session Auth</span>
              </div>
              <h1 className="workspace-title">Sign in to Threadboard</h1>
            </div>
          </div>
        </header>

        <main className="auth-panel">
          <div className="auth-card">
            <div
              className="auth-mode-switch"
              role="tablist"
              aria-label="Authentication mode"
            >
              <button
                type="button"
                role="tab"
                aria-selected={authMode === "login"}
                className={`auth-tab ${authMode === "login" ? "is-active" : ""}`}
                onClick={() => switchAuthMode("login")}
                disabled={isSubmittingAuth}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={authMode === "register"}
                className={`auth-tab ${
                  authMode === "register" ? "is-active" : ""
                }`}
                onClick={() => switchAuthMode("register")}
                disabled={isSubmittingAuth}
              >
                Create account
              </button>
            </div>

            {sessionNotice && (
              <div className="auth-notice-banner" role="status" aria-live="polite">
                {sessionNotice}
              </div>
            )}

            {authError && (
              <div
                id="auth-error"
                className="send-error-banner"
                role="alert"
                aria-live="assertive"
              >
                <span>{authError}</span>
              </div>
            )}

            <form
              className="auth-form"
              onSubmit={handleAuthSubmit}
              noValidate
              aria-describedby={authError ? "auth-error" : undefined}
            >
              {authMode === "register" && (
                <div className="form-field">
                  <label htmlFor="auth-display-name" className="composer-label">
                    Display name
                  </label>
                  <input
                    id="auth-display-name"
                    name="displayName"
                    type="text"
                    className="composer-input"
                    placeholder="Ada Lovelace"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoComplete="name"
                    required
                    minLength={2}
                    maxLength={50}
                    disabled={isSubmittingAuth}
                  />
                </div>
              )}

              <div className="form-field">
                <label htmlFor="auth-email" className="composer-label">
                  Email address
                </label>
                <input
                  id="auth-email"
                  name="email"
                  type="email"
                  className="composer-input"
                  placeholder="ada@threadboard.dev"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                  disabled={isSubmittingAuth}
                />
              </div>

              <div className="form-field">
                <label htmlFor="auth-password" className="composer-label">
                  Password
                </label>
                <input
                  id="auth-password"
                  name="password"
                  type="password"
                  className="composer-input"
                  placeholder={
                    authMode === "register"
                      ? "At least 8 characters"
                      : "Enter your password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={
                    authMode === "register"
                      ? "new-password"
                      : "current-password"
                  }
                  required
                  minLength={authMode === "register" ? 8 : 1}
                  disabled={isSubmittingAuth}
                />
              </div>

              <button
                type="submit"
                className="send-button auth-submit-button"
                disabled={isSubmittingAuth}
              >
                {isSubmittingAuth
                  ? authMode === "register"
                    ? "Creating account..."
                    : "Signing in..."
                  : authMode === "register"
                    ? "Create account"
                    : "Sign in"}
              </button>
            </form>
          </div>
        </main>
      </div>
    );
  }

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
          <span className="user-badge" title={user.email}>
            {user.displayName}
          </span>
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
          <button
            type="button"
            className="logout-button"
            onClick={() => void handleLogout()}
            disabled={isLoggingOut}
          >
            {isLoggingOut ? "Logging out..." : "Log out"}
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
                  <span
                    className={`entry-author ${
                      msg.authorName ? "" : "is-legacy"
                    }`}
                  >
                    {msg.authorName ?? "Legacy record"}
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

        <form className="composer-form" onSubmit={handleMessageSubmit} noValidate>
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
