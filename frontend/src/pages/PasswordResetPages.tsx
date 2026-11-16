// "Forgot password" (asks for an emailed link) and "Reset password" (opened
// from that link: /reset-password?token=...). Both work without a session.
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";

import { api } from "../api/client";

function Card({
  title,
  onSubmit,
  children,
}: {
  title: string;
  onSubmit?: (e: FormEvent) => void;
  children: ReactNode;
}) {
  const body = (
    <>
      <h1>{title}</h1>
      {children}
    </>
  );
  return (
    <div className="login">
      {onSubmit ? (
        <form className="login-card" onSubmit={onSubmit}>
          {body}
        </form>
      ) : (
        <div className="login-card">{body}</div>
      )}
    </div>
  );
}

const backToLogin = (
  <p className="small muted">
    <Link className="btn-link" to="/login">
      Back to log in
    </Link>
  </p>
);

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const send = useMutation({ mutationFn: () => api.requestPasswordReset(email) });

  if (send.isSuccess) {
    return (
      <Card title="Check your email">
        <p role="status">{send.data.detail}</p>
        <p className="small muted">The link expires after a short time and works once.</p>
        {backToLogin}
      </Card>
    );
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };
  return (
    <Card title="Forgot password" onSubmit={onSubmit}>
      <p className="small muted">We'll email you a link to choose a new password.</p>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          className="input"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      {send.isError && (
        <p className="error" role="alert">
          {send.error.message}
        </p>
      )}
      <button type="submit" className="btn btn-primary" disabled={send.isPending}>
        {send.isPending ? "Please wait…" : "Send link"}
      </button>
      {backToLogin}
    </Card>
  );
}

export function ResetPasswordPage() {
  const token = useSearchParams()[0].get("token") ?? "";
  const [password, setPassword] = useState("");
  const reset = useMutation({ mutationFn: () => api.confirmPasswordReset(token, password) });

  if (!token) {
    return (
      <Card title="Reset password">
        <p className="error" role="alert">
          This link is incomplete. Open the link from the email again, or ask for a new one.
        </p>
        <p className="small muted">
          <Link className="btn-link" to="/forgot-password">
            Ask for a new link
          </Link>
        </p>
      </Card>
    );
  }
  if (reset.isSuccess) {
    return (
      <Card title="Password changed">
        <p role="status">Your password was changed. You were logged out everywhere.</p>
        <Link className="btn btn-primary" to="/login">
          Log in
        </Link>
      </Card>
    );
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    reset.mutate();
  };
  return (
    <Card title="Choose a new password" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="password">New password</label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <span className="hint">At least 10 characters.</span>
      </div>
      {reset.isError && (
        <div role="alert">
          <p className="error">{reset.error.message}</p>
          <Link className="btn-link small" to="/forgot-password">
            Ask for a new link
          </Link>
        </div>
      )}
      <button type="submit" className="btn btn-primary" disabled={reset.isPending}>
        {reset.isPending ? "Please wait…" : "Set password"}
      </button>
    </Card>
  );
}
