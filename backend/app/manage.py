"""Admin commands.

    python -m app.manage create-user someone@example.org [--admin]   (prompts for the password)
"""

from __future__ import annotations

import argparse
import getpass
import sys

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select

from .auth.passwords import hash_password
from .db import get_sessionmaker
from .models import User
from .schemas.api import Registration


def create_user(email: str, admin: bool) -> int:
    password = getpass.getpass("Password: ")
    if password != getpass.getpass("Repeat password: "):
        print("Passwords do not match", file=sys.stderr)
        return 1
    try:
        body = TypeAdapter(Registration).validate_python({"email": email, "password": password})
    except ValidationError as exc:
        print(exc, file=sys.stderr)
        return 1
    with get_sessionmaker()() as db:
        if db.scalar(select(User).where(User.email == body.email.lower())):
            print(f"User {body.email} already exists", file=sys.stderr)
            return 1
        db.add(User(email=body.email.lower(), password_hash=hash_password(body.password),
                    role="admin" if admin else "user"))
        db.commit()
    print(f"Created {'admin' if admin else 'user'} {body.email}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("create-user", help="create a user account")
    p.add_argument("email")
    p.add_argument("--admin", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "create-user":
        return create_user(args.email, args.admin)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
