# API and worker image (same image, different command - see deploy/compose.yaml).
FROM docker.io/library/python:3.14.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    APP_ENV=production \
    UPLOAD_DIR=/data/uploads

RUN useradd --system --uid 10001 --home-dir /app app \
    && mkdir -p /data/uploads && chown app:app /data/uploads
WORKDIR /app

# Dependencies first (this layer is cached until pyproject/constraints change),
# pinned to the versions tested in development. The project itself is installed
# empty and removed again: only its dependencies stay; the code runs from /app.
COPY pyproject.toml constraints.txt ./
RUN mkdir app pipeline && pip install -c constraints.txt ".[api]" && pip uninstall -y entitynetworks

COPY alembic.ini ./
COPY alembic ./alembic
COPY pipeline ./pipeline
COPY app ./app

USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"]

# ONE process on purpose: the login/upload rate limiter lives in memory.
# Caddy is the only client, so trusting its X-Forwarded-For is safe.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*", "--no-server-header", \
     "--log-config", "app/log_config.json"]
