import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";

import { api } from "../api/client";
import { SESSION_KEY, useSession } from "../auth/session";

type Mode = "login" | "register";

export function LoginPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/datasets";

  const submit = useMutation({
    mutationFn: () =>
      mode === "login" ? api.login(email, password) : api.register(email, password),
    onSuccess: (s) => {
      qc.setQueryData(SESSION_KEY, s);
      navigate(from, { replace: true });
    },
  });

  if (session.data) return <Navigate to={from} replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };
  const isLogin = mode === "login";

  return (
    <div className="login">
      <form className="login-card" onSubmit={onSubmit} noValidate={false}>
        <div>
          <h1>{isLogin ? "Log in" : "Create an account"}</h1>
          <p className="muted small" style={{ marginTop: 4 }}>
            EntityNetworks · research collaboration networks
          </p>
        </div>
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
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete={isLogin ? "current-password" : "new-password"}
            required
            minLength={isLogin ? 1 : 10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {!isLogin && <span className="hint">At least 10 characters.</span>}
        </div>
        {submit.isError && (
          <p className="error" role="alert">
            {submit.error.message}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={submit.isPending}>
          {submit.isPending ? "Please wait…" : isLogin ? "Log in" : "Create account"}
        </button>
        <p className="small muted">
          {isLogin ? "No account yet? " : "Already have an account? "}
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              setMode(isLogin ? "register" : "login");
              submit.reset();
            }}
          >
            {isLogin ? "Create one" : "Log in"}
          </button>
        </p>
      </form>
    </div>
  );
}
