import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import {
  Alert,
  AppShell,
  BrandMark,
  Button,
  SegmentedControl,
  TextField,
} from "@fintech-network/design-system";
import { brand } from "../config/brand";
import { useSession } from "../session/SessionContext";
import { ApiError } from "../api/client";

// You sign in as yourself, not as a shop — which shop you're working
// for is the next question, not part of signing in.

type Mode = "signin" | "register";

export function WelcomeScreen() {
  const session = useSession();
  const location = useLocation();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (session.status === "signed-in") {
    const to = (location.state as { from?: string } | null)?.from ?? "/";
    return <Navigate to={to} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "register" && password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "register") await session.register(email.trim(), password);
      else await session.signIn(email.trim(), password);
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_IN_USE") {
        setError("There's already an account with this email. Try signing in.");
      } else if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") {
        setError("That email and password don't match.");
      } else if (err instanceof ApiError && err.code === "VALIDATION_ERROR") {
        setError("Check your email address and try again.");
      } else if (err instanceof ApiError && err.status === 429) {
        setError("Too many attempts. Wait a minute and try again.");
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <div className="ds-auth">
        <BrandMark name={`${brand.name} for business`} />
        <div className="ds-stack">
          <p className="ds-lead">
            {mode === "register" ? "Take payments in seconds." : "Welcome back."}
          </p>
          <p className="ds-muted">
            {mode === "register"
              ? "Put an amount on the till, show the code, and watch it get paid."
              : "Sign in to your till."}
          </p>
        </div>

        {session.notice ? <Alert tone="info">{session.notice}</Alert> : null}

        <SegmentedControl<Mode>
          label="Account"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(null);
          }}
          options={[
            { value: "signin", label: "Sign in" },
            { value: "register", label: "Create account" },
          ]}
        />

        <form className="ds-stack ds-stack--lg" onSubmit={onSubmit} noValidate>
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            required
            hint={mode === "register" ? "At least 8 characters" : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button type="submit" block loading={submitting} disabled={!email || !password}>
            {mode === "register" ? "Create account" : "Sign in"}
          </Button>
        </form>

        <p className="ds-muted ds-small">
          Prototype only. Payments are simulated and no real money moves. You
          sign in as yourself; shops you work for come next.
        </p>
      </div>
    </AppShell>
  );
}
