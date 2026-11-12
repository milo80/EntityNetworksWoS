"""Background worker: executes queued network runs.

    python -m app.worker

The network_runs table is the queue. A run is claimed with
SELECT ... FOR UPDATE SKIP LOCKED, so jobs survive restarts and no broker
(Redis/Celery) is needed. Designed for ONE worker process: on startup, runs
left 'running' by a crashed/killed worker are requeued (up to
WORKER_MAX_ATTEMPTS) - with several workers that recovery step would need a
heartbeat instead.
"""

from __future__ import annotations

import logging
import signal
import threading
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from pipeline.io import WoSReadError

from .config import Settings, get_settings
from .db import get_sessionmaker, utcnow
from .logging import configure_logging
from .models import Dataset, NetworkRun
from .services.runs import build_network
from .services.storage import dataset_dir

log = logging.getLogger(__name__)

MAX_ERROR_LEN = 2000


def recover_orphaned_runs(db: Session, max_attempts: int) -> int:
    """Requeue (or fail, once out of attempts) runs a dead worker left 'running'."""
    orphaned = db.scalars(select(NetworkRun).where(NetworkRun.status == "running")).all()
    for run in orphaned:
        if run.attempts >= max_attempts:
            run.status, run.finished_at = "failed", utcnow()
            run.error = "Worker stopped while processing this run (attempts exhausted)"
        else:
            run.status, run.started_at = "queued", None
    db.commit()
    if orphaned:
        log.warning("Recovered %d orphaned run(s)", len(orphaned))
    return len(orphaned)


def claim_next_run(db: Session) -> NetworkRun | None:
    run = db.scalars(select(NetworkRun).where(NetworkRun.status == "queued")
                     .order_by(NetworkRun.id).limit(1)
                     .with_for_update(skip_locked=True)).first()
    if run is None:
        db.rollback()
        return None
    run.status, run.started_at, run.attempts = "running", utcnow(), run.attempts + 1
    db.commit()
    return run


def _user_facing_error(exc: Exception) -> str:
    if isinstance(exc, WoSReadError):
        return str(exc)[:MAX_ERROR_LEN]
    if isinstance(exc, KeyError):  # a required WoS column is missing
        return f"The uploaded files are missing a required WoS column: {exc}"[:MAX_ERROR_LEN]
    return "The network could not be built from these files (see server logs)"


def execute_run(db: Session, run: NetworkRun, settings: Settings) -> None:
    dataset = db.get(Dataset, run.dataset_id)
    # Stored names are random, so order by the original names: the result then
    # doesn't depend on upload order, and matches the CLI run on the same folder.
    ordered = sorted(dataset.files, key=lambda f: (f.original_name, f.id)) if dataset else []
    files = [dataset_dir(settings.upload_dir, dataset.id) / f.stored_name for f in ordered]
    db.commit()  # end the read transaction; don't sit "idle in transaction" while building
    log.info("Run %d: building %s network from %d file(s)", run.id, run.relation, len(files))
    try:
        if not files:
            raise WoSReadError("Dataset has no files")
        network = build_network(run.relation, run.params, [Path(p) for p in files])
    except Exception as exc:
        log.exception("Run %d failed", run.id)
        values = {"status": "failed", "error": _user_facing_error(exc)}
    else:
        values = {"status": "succeeded", "error": None, "result": network,
                  "node_count": len(network["nodes"]), "edge_count": len(network["edges"])}
    # UPDATE by id: if the run/dataset was deleted meanwhile this simply touches 0 rows.
    db.execute(update(NetworkRun).where(NetworkRun.id == run.id, NetworkRun.status == "running")
               .values(finished_at=utcnow(), **values))
    db.commit()
    log.info("Run %d: %s", run.id, values["status"])


def run_once(db: Session, settings: Settings) -> bool:
    """Process at most one queued run. Returns True if one was processed."""
    run = claim_next_run(db)
    if run is None:
        return False
    execute_run(db, run, settings)
    return True


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    make_session = get_sessionmaker()
    with make_session() as db:
        recover_orphaned_runs(db, settings.worker_max_attempts)
    log.info("Worker started (poll every %.1fs)", settings.worker_poll_seconds)

    while not stop.is_set():
        try:
            with make_session() as db:
                processed = run_once(db, settings)
        except Exception:
            log.exception("Worker loop error; retrying")
            processed = False
        if not processed:
            stop.wait(settings.worker_poll_seconds)
    log.info("Worker stopped")


if __name__ == "__main__":
    main()
