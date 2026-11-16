import smtplib
from typing import ClassVar

from pydantic import SecretStr

from app.config import Settings
from app.services import mailer


class FakeSMTP:
    instances: ClassVar[list[FakeSMTP]] = []

    def __init__(self, host, port, timeout):
        self.host, self.port, self.timeout = host, port, timeout
        self.calls: list[str] = []
        self.sent = []
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self, context):
        self.calls.append("starttls")

    def login(self, user, password):
        self.calls.append(f"login {user} {password}")

    def send_message(self, msg):
        self.calls.append("send")
        self.sent.append(msg)


def smtp_settings(**overrides) -> Settings:
    values = {
        "smtp_host": "smtp.example.org",
        "smtp_port": 587,
        "smtp_username": "bot@example.org",
        "smtp_password": SecretStr("app-password"),
        "smtp_from": "App <bot@example.org>",
    }
    return Settings(**(values | overrides))


def test_sends_over_starttls_with_login(monkeypatch):
    FakeSMTP.instances.clear()
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    mailer.send_email(smtp_settings(), "ann@example.org", "Hello", "Body text")
    smtp = FakeSMTP.instances[0]
    assert (smtp.host, smtp.port) == ("smtp.example.org", 587)
    assert smtp.calls == ["starttls", "login bot@example.org app-password", "send"]
    msg = smtp.sent[0]
    assert msg["To"] == "ann@example.org" and msg["From"] == "App <bot@example.org>"
    assert msg["Subject"] == "Hello" and "Body text" in msg.get_content()


def test_delivery_errors_are_logged_not_raised(monkeypatch, caplog):
    class Broken(FakeSMTP):
        def send_message(self, msg):
            raise smtplib.SMTPRecipientsRefused({})

    monkeypatch.setattr(smtplib, "SMTP", Broken)
    mailer.send_email(smtp_settings(), "ann@example.org", "Hello", "Body")
    assert "failed" in caplog.text


def test_without_host_logs_instead_of_sending(monkeypatch, caplog):
    monkeypatch.setattr(smtplib, "SMTP", None)  # would crash if used
    with caplog.at_level("WARNING"):
        mailer.send_email(Settings(smtp_host=None), "ann@example.org", "Hello", "the link")
    assert "NOT sent" in caplog.text and "the link" in caplog.text


def test_smtp_from_required_with_host():
    import pytest

    with pytest.raises(ValueError, match="SMTP_FROM"):
        Settings(smtp_host="smtp.example.org", smtp_from=None)
