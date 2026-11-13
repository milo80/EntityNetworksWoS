"""Smoke test: black-box check of a RUNNING deployment (API + worker + database) over HTTP.

pytest runs the app in-process; this checks the assembled system the way it
actually runs: real server, separate worker process, real cookies and uploads.
Intended for local runs, CI after `docker compose up`, and after every deploy.

    # local / CI (creates the account if needed)
    python scripts/smoke_test.py --base-url http://127.0.0.1:8000 --register \\
        --email smoke@example.org --password 'some-long-password' \\
        --golden tests/fixtures/golden/network_author.json

    # the Docker Compose stack through Caddy (local TLS certificate):
    python scripts/smoke_test.py --base-url https://localhost:8443 --insecure --proxy ...

    # production (registration disabled): pre-create the account once with
    #   python -m app.manage create-user smoke@example.org
    SMOKE_EMAIL=... SMOKE_PASSWORD=... python scripts/smoke_test.py --base-url https://...

--proxy adds checks of the web server in front (Caddy): the UI is served, also
for deep links, with the security headers, and the network JSON is compressed.

Leaves nothing behind: the uploaded dataset (and its run) is deleted at the end
unless --keep is given. Exit code 0 = all checks passed.

Not covered here: crash recovery (kill -9 the worker mid-run, restart it, and the
run is requeued and finishes). That needs control over the processes, so it is a
manual local check - see docs/design-notes.md.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections.abc import Callable
from pathlib import Path

import httpx

from pipeline.schema import validate_network

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare_networks import compare

CSRF_HEADER = "X-CSRF-Token"
SECURITY_HEADERS = ("content-security-policy", "x-content-type-options", "referrer-policy",
                    "permissions-policy")


class SmokeFailure(Exception):
    pass


def expect(response: httpx.Response, status: int, what: str) -> httpx.Response:
    if response.status_code != status:
        raise SmokeFailure(f"{what}: expected HTTP {status}, got {response.status_code}: "
                           f"{response.text[:300]}")
    return response


class Smoke:
    def __init__(self, base_url: str, timeout: float, verify: bool | str = True):
        self.site = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout,
                                 follow_redirects=False, verify=verify)
        self.client = httpx.Client(base_url=base_url.rstrip("/") + "/api", timeout=timeout,
                                   follow_redirects=False, verify=verify)
        self.csrf: str | None = None
        self.passed = 0

    def step(self, name: str, fn: Callable[[], str | None]) -> None:
        start = time.monotonic()
        try:
            detail = fn()
        except (SmokeFailure, httpx.HTTPError, ValueError) as exc:
            print(f"FAIL  {name} ({time.monotonic() - start:.1f}s)\n      {exc}")
            raise
        self.passed += 1
        suffix = f" - {detail}" if detail else ""
        print(f"PASS  {name} ({time.monotonic() - start:.1f}s){suffix}")

    @property
    def csrf_headers(self) -> dict[str, str]:
        return {CSRF_HEADER: self.csrf or ""}


def run(args: argparse.Namespace) -> int:
    files = sorted(Path(args.wos_dir).glob("*.xls"))
    if not files:
        print(f"No .xls files in {args.wos_dir}", file=sys.stderr)
        return 2
    verify: bool | str = False if args.insecure else (args.ca_cert or True)
    s = Smoke(args.base_url, args.http_timeout, verify)
    state: dict = {}
    creds = {"email": args.email, "password": args.password}

    def health():
        body = expect(s.client.get("/health"), 200, "health").json()
        if body.get("database") != "ok":
            raise SmokeFailure(f"health: {body}")
        return "database ok"

    def web_front():
        https = args.base_url.startswith("https://")
        for path in ("/", "/datasets/1"):  # deep links fall back to the SPA's index.html
            r = expect(s.site.get(path), 200, f"GET {path}")
            if 'id="root"' not in r.text:
                raise SmokeFailure(f"GET {path}: not the UI's index.html")
        api = expect(s.client.get("/health"), 200, "health")
        for resp, what in ((r, "UI"), (api, "API")):
            missing = [h for h in SECURITY_HEADERS + (("strict-transport-security",) if https else ())
                       if h not in resp.headers]
            if missing:
                raise SmokeFailure(f"{what} response lacks headers: {', '.join(missing)}")
        if "default-src 'self'" not in r.headers["content-security-policy"]:
            raise SmokeFailure(f"weak CSP: {r.headers['content-security-policy']}")
        if "server" in api.headers and "uvicorn" in api.headers["server"].lower():
            raise SmokeFailure("API responses reveal the uvicorn server header")
        return "UI + deep link served, security headers present" + (", HSTS" if https else "")

    def register():
        r = s.client.post("/auth/register", json=creds)
        if r.status_code == 409:
            return "account already exists"
        expect(r, 201, "register")
        return "account created"

    def login():
        body = expect(s.client.post("/auth/login", json=creds), 200, "login").json()
        s.csrf = body["csrf_token"]
        if "entitynet_session" not in s.client.cookies:
            raise SmokeFailure("login: no session cookie set")
        return f"as {body['user']['email']}"

    def me():
        expect(s.client.get("/auth/me"), 200, "me")

    def multipart():
        return [("files", (p.name, p.read_bytes(), "application/vnd.ms-excel")) for p in files]

    def upload_without_csrf():
        r = s.client.post("/datasets", data={"name": "smoke (should be rejected)"},
                          files=multipart())
        expect(r, 403, "upload without CSRF header")
        return "rejected as expected"

    def upload():
        r = s.client.post("/datasets", data={"name": f"smoke test {time.strftime('%F %T')}"},
                          files=multipart(), headers=s.csrf_headers)
        body = expect(r, 201, "upload").json()
        state["dataset_id"] = body["id"]
        size_mb = sum(f["size_bytes"] for f in body["files"]) / 1e6
        return f"dataset {body['id']}, {len(body['files'])} files, {size_mb:.1f} MB"

    def run_network():
        r = s.client.post("/runs", json={"dataset_id": state["dataset_id"],
                                         "relation": args.relation}, headers=s.csrf_headers)
        run_id = expect(r, 202, "queue run").json()["id"]
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            status = expect(s.client.get(f"/runs/{run_id}"), 200, "run status").json()
            if status["status"] in ("succeeded", "failed"):
                break
            time.sleep(1)
        else:
            raise SmokeFailure(f"run {run_id} still {status['status']} after {args.timeout}s "
                               "- is the worker running?")
        if status["status"] != "succeeded":
            raise SmokeFailure(f"run {run_id} failed: {status['error']}")
        state["run"] = status
        return (f"run {run_id} {args.relation}: {status['node_count']} nodes, "
                f"{status['edge_count']} edges")

    def download():
        run_ = state["run"]
        r = expect(s.client.get(f"/runs/{run_['id']}/network"), 200, "network")
        network = validate_network(r.content)
        if (len(network.nodes), len(network.edges)) != (run_["node_count"], run_["edge_count"]):
            raise SmokeFailure("network size differs from the run's reported counts")
        etag = r.headers.get("etag")
        if not etag:
            raise SmokeFailure("network: no ETag header")
        expect(s.client.get(f"/runs/{run_['id']}/network", headers={"If-None-Match": etag}),
               304, "network with If-None-Match")
        state["network"] = r.json()
        detail = f"valid against schema, {len(r.content) / 1e6:.1f} MB, ETag -> 304"
        if args.proxy:
            encoding = r.headers.get("content-encoding")
            if encoding not in ("gzip", "zstd", "br"):
                raise SmokeFailure("network JSON is not compressed by the proxy")
            detail += f", sent {encoding}-compressed"
        return detail

    def golden():
        expected = json.loads(Path(args.golden).read_text(encoding="utf-8"))
        if state["network"] != expected:
            raise SmokeFailure("differs from golden:\n      " +
                               "\n      ".join(compare(expected, state["network"], 5)))
        return f"identical to {Path(args.golden).name}"

    def cleanup():
        expect(s.client.delete(f"/datasets/{state['dataset_id']}", headers=s.csrf_headers),
               204, "delete dataset")
        expect(s.client.get(f"/runs/{state['run']['id']}"), 404, "run gone with its dataset")
        return f"dataset {state['dataset_id']} and its run deleted"

    def logout():
        expect(s.client.post("/auth/logout", headers=s.csrf_headers), 204, "logout")
        expect(s.client.get("/auth/me"), 401, "me after logout")
        return "session invalidated"

    steps = [("health", health)]
    if args.proxy:
        steps.append(("web front (proxy)", web_front))
    if args.register:
        steps.append(("register", register))
    steps += [("login", login), ("current user", me),
              ("upload rejected without CSRF", upload_without_csrf),
              ("upload WoS files", upload), ("build network (worker)", run_network),
              ("download network", download)]
    if args.golden:
        steps.append(("compare with golden", golden))
    if not args.keep:
        steps.append(("cleanup", cleanup))
    steps.append(("logout", logout))

    print(f"Smoke test against {args.base_url}")
    started = time.monotonic()
    try:
        for name, fn in steps:
            s.step(name, fn)
    except (SmokeFailure, httpx.HTTPError, ValueError):
        print(f"\nFAILED after {s.passed}/{len(steps)} checks "
              f"(dataset {state.get('dataset_id', '-')} left in place for inspection)")
        return 1
    finally:
        s.client.close()
        s.site.close()
    print(f"\nOK: {len(steps)}/{len(steps)} checks passed in {time.monotonic() - started:.0f}s")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--email", default=os.environ.get("SMOKE_EMAIL"))
    parser.add_argument("--password", default=os.environ.get("SMOKE_PASSWORD"))
    parser.add_argument("--register", action="store_true",
                        help="create the account first (dev/CI; needs ALLOW_REGISTRATION)")
    parser.add_argument("--wos-dir", default=str(Path(__file__).resolve().parents[2] / "data" / "wos"))
    parser.add_argument("--relation", default="author", choices=["author", "institution_keywords"])
    parser.add_argument("--golden", help="network JSON the result must equal")
    parser.add_argument("--timeout", type=float, default=180, help="seconds to wait for the run")
    parser.add_argument("--http-timeout", type=float, default=60, help="per-request timeout")
    parser.add_argument("--proxy", action="store_true",
                        help="also check the web server in front (UI, security headers, gzip)")
    tls = parser.add_mutually_exclusive_group()
    tls.add_argument("--ca-cert", help="CA certificate to trust (e.g. Caddy's local CA)")
    tls.add_argument("--insecure", action="store_true", help="don't verify TLS certificates")
    parser.add_argument("--keep", action="store_true", help="don't delete the dataset at the end")
    args = parser.parse_args(argv)
    if not args.email or not args.password:
        parser.error("--email/--password (or SMOKE_EMAIL/SMOKE_PASSWORD) are required")
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
