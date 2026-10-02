import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { Alert, AppShell, BrandMark, Button, TextField } from "@fintech-network/design-system";
import { useSession } from "../session/SessionContext";
import { ApiError } from "../api/client";

const APP_NAME = import.meta.env.VITE_APP_NAME ?? "FinTech Network";

// Sign in only. No "create an account" tab, because there is no public
// path to an admin account and this app isn't going to invent one —
// they're made out of band, which is a deliberate choice rather than an
// omission (spec §17).

export function SignInScreen() {
  const session = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (session.status === "signed-in") return <Navigate to="/" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await session.signIn(email.trim(), password);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") {
        setError("That email and password don't match.");
      } else if (err instanceof ApiError && err.status === 429) {
        setError("Too many attempts. Wait a few minutes and try again.");
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <BrandMark name={`${APP_NAME} Admin`} />
      {session.notice ? <Alert tone="info">{session.notice}</Alert> : null}
      <form className="ds-stack" onSubmit={onSubmit}>
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" block disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="ds-muted ds-small">
        Admin accounts aren't created here. Ask someone who already has one.
      </p>
    </AppShell>
  );
}
