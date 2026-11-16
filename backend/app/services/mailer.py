"""Outgoing email over SMTP (stdlib smtplib; no extra dependency or service).

Configured by the SMTP_* settings. Without SMTP_HOST (development, CI, tests)
nothing is sent: the message is written to the log instead, so flows such as
password reset can still be followed by reading the API log. Delivery errors
are logged, never raised: callers run this in the background after the
response has been sent.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage

from ..config import Settings

log = logging.getLogger(__name__)


def send_email(settings: Settings, to: str, subject: str, body: str) -> None:
    if not settings.smtp_host:
        log.warning("SMTP_HOST is not set; email NOT sent. To: %s | Subject: %s\n%s",
                    to, subject, body)
        return

    msg = EmailMessage()
    msg["From"] = settings.smtp_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port,
                          timeout=settings.smtp_timeout_seconds) as smtp:
            if settings.smtp_starttls:
                smtp.starttls(context=ssl.create_default_context())
            if settings.smtp_username and settings.smtp_password:
                smtp.login(settings.smtp_username, settings.smtp_password.get_secret_value())
            smtp.send_message(msg)
    except (smtplib.SMTPException, OSError):
        log.exception("Sending email to %s failed (subject: %s)", to, subject)
        return
    log.info("Email sent to %s (subject: %s)", to, subject)
