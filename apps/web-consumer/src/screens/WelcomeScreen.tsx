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

type Mode = "signin" | "register";

export function WelcomeScreen() {
  const session = useSession();
  const location = useLocation();
  const [mode, setMode] = useState<Mode>("register");
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
        <BrandMark name={brand.name} />
        <div className="ds-stack">
          <p className="ds-lead">
            {mode === "register" ? "Pay people you can trust." : "Welcome back."}
          </p>
          <p className="ds-muted">
            {mode === "register"
              ? "Every payment shows who it's to, what it's for and proof it happened."
              : "Sign in to see your balance and activity."}
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
            { value: "register", label: "Create account" },
            { value: "signin", label: "Sign in" },
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
          Prototype only. Balances are simulated, no real money moves, and new
          accounts start with £500.00 of test funds.
        </p>
      </div>
    </AppShell>
  );
}
