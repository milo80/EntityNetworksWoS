"""Background worker: profiles newly uploaded datasets and executes queued network runs.

    python -m app.worker

Uploaded files are parsed only here, never in the API process.

The network_runs table is the queue. A run is claimed with
SELECT ... FOR UPDATE SKIP LOCKED, so jobs survive restarts and no broker
(Redis/Celery) is needed. Designed for ONE worker process: on startup, runs
left 'running' by a crashed/killed worker are requeued (up to
WORKER_MAX_ATTEMPTS) - with several workers that recovery step would need a
heartbeat instead. A PostgreSQL advisory lock, held for the worker's lifetime,
makes a second worker refuse to start.
"""

from __future__ import annotations

import logging
import signal
import threading
from pathlib import Path
from typing import Any

from sqlalchemy import Connection, Engine, delete, func, insert, or_, select, text, update
from sqlalchemy.orm import Session

from pipeline.custom import NetworkBuildError
from pipeline.io import WoSReadError, read_wos_files
from pipeline.profile import PROFILE_VERSION, profile_dataset
from pipeline.records import dataset_records

from .config import Settings, get_settings
from .db import get_sessionmaker, utcnow
from .logging import configure_logging
from .models import Dataset, DatasetRecord, NetworkRun
from .services.runs import build_network
from .services.storage import dataset_dir

log = logging.getLogger(__name__)

# Arbitrary app-wide key for pg_try_advisory_lock ("EN" + 1).
WORKER_LOCK_KEY = 0x454E_0001

MAX_ERROR_LEN = 2000


def acquire_worker_lock(engine: Engine) -> Connection | None:
    """Hold the single-worker lock on a dedicated connection; None if another worker has it.

    The lock is released when the connection closes, including when the process dies.
    """
    conn = engine.connect()
    conn.detach()  # out of the pool, so close() really ends the session (and the lock)
    if conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": WORKER_LOCK_KEY}).scalar():
        conn.commit()  # the lock is session-level: it outlives this transaction
        return conn
    conn.close()
    return None


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
    run = db.scalars(
        select(NetworkRun)
        .where(NetworkRun.status == "queued")
        .order_by(NetworkRun.id)
        .limit(1)
        .with_for_update(skip_locked=True)
    ).first()
    if run is None:
        db.rollback()
        return None
    run.status, run.started_at, run.attempts = "running", utcnow(), run.attempts + 1
    db.commit()
    return run


def _user_facing_error(
    exc: Exception,
    generic: str = "The network could not be built from these files (see server logs)",
) -> str:
    if isinstance(exc, WoSReadError | NetworkBuildError):
        return str(exc)[:MAX_ERROR_LEN]
    if isinstance(exc, KeyError):  # a required WoS column is missing
        return f"The uploaded files are missing a required WoS column: {exc}"[:MAX_ERROR_LEN]
    return generic


def dataset_file_paths(dataset: Dataset | None, settings: Settings) -> list[Path]:
    """A dataset's files on disk, in a deterministic order.

    Stored names are random, so order by the original names: results then don't
    depend on upload order, and match the CLI run on the same folder.
    """
    if dataset is None:
        return []
    ordered = sorted(dataset.files, key=lambda f: (f.original_name, f.id))
    return [dataset_dir(settings.upload_dir, dataset.id) / f.stored_name for f in ordered]


def _profile_and_records(dataset: Dataset, settings: Settings) -> tuple[dict, list[dict]]:
    """Read the dataset's files once: its profile and its records (nothing stored yet)."""
    files = dataset_file_paths(dataset, settings)
    if not files:
        raise WoSReadError("Dataset has no files")
    df = read_wos_files(files)
    return profile_dataset(df), dataset_records(df)


def _store_records(db: Session, dataset_id: int, records: list[dict]) -> None:
    """Replace the dataset's records (in the caller's transaction)."""
    db.execute(delete(DatasetRecord).where(DatasetRecord.dataset_id == dataset_id))
    if records:
        db.execute(
            insert(DatasetRecord),
            [{"dataset_id": dataset_id, "position": i, "data": r} for i, r in enumerate(records)],
        )


def profile_next_dataset(db: Session, settings: Settings) -> bool:
    """Compute the profile of one pending dataset. Returns True if one was processed.

    The row stays locked (FOR UPDATE SKIP LOCKED) while profiling - about a second
    for the 14 MB sample - so a crash leaves it 'pending' and it is retried.
    """
    dataset = db.scalars(
        select(Dataset)
        .where(Dataset.profile_status == "pending")
        .order_by(Dataset.id)
        .limit(1)
        .with_for_update(skip_locked=True)
    ).first()
    if dataset is None:
        db.rollback()
        return refresh_outdated_profile(db, settings)
    dataset_id = dataset.id
    try:
        profile, records = _profile_and_records(dataset, settings)
        _store_records(db, dataset_id, records)
        dataset.profile = profile
        dataset.profile_status, dataset.profile_error = "ready", None
        db.commit()  # inside the try: storing can fail too (e.g. text PostgreSQL rejects)
        status = "ready"
    except Exception as exc:
        log.exception("Profiling dataset %d failed", dataset_id)
        # The transaction may be aborted: start over, so the failure is recorded and the
        # dataset isn't picked again forever (which would starve the run queue).
        db.rollback()
        db.execute(
            update(Dataset)
            .where(Dataset.id == dataset_id, Dataset.profile_status == "pending")
            .values(
                profile_status="failed",
                profile_error=_user_facing_error(
                    exc, "These files could not be read as WoS exports (see server logs)"
                ),
            )
        )
        db.commit()
        status = "failed"
    log.info("Dataset %d profile: %s", dataset_id, status)
    return True


def execute_run(db: Session, run: NetworkRun, settings: Settings) -> None:
    files = dataset_file_paths(db.get(Dataset, run.dataset_id), settings)
    db.commit()  # end the read transaction; don't sit "idle in transaction" while building
    log.info("Run %d: building %s network from %d file(s)", run.id, run.relation, len(files))
    values: dict[str, Any]
    try:
        if not files:
            raise WoSReadError("Dataset has no files")
        network = build_network(run.relation, run.params, [Path(p) for p in files])
    except Exception as exc:
        log.exception("Run %d failed", run.id)
        values = {"status": "failed", "error": _user_facing_error(exc)}
    else:
        values = {
            "status": "succeeded",
            "error": None,
            "result": network,
            "node_count": len(network["nodes"]),
            "edge_count": len(network["edges"]),
        }
    # UPDATE by id: if the run/dataset was deleted meanwhile this simply touches 0 rows.
    db.execute(
        update(NetworkRun)
        .where(NetworkRun.id == run.id, NetworkRun.status == "running")
        .values(finished_at=utcnow(), **values)
    )
    db.commit()
    log.info("Run %d: %s", run.id, values["status"])


def _profile_version(field: str):
    return func.coalesce(Dataset.profile[field].as_integer(), 0)


def refresh_outdated_profile(db: Session, settings: Settings) -> bool:
    """Recompute one 'ready' profile older than PROFILE_VERSION, in place.

    The dataset stays 'ready' and keeps its old profile until the new one is
    stored, so existing datasets gain new profile content without a migration;
    their records are stored (or replaced) in the same transaction.
    A failure keeps the old profile and is remembered (refresh_failed_version),
    so it isn't retried every iteration.
    """
    dataset = db.scalars(
        select(Dataset)
        .where(
            Dataset.profile_status == "ready",
            _profile_version("version") < PROFILE_VERSION,
            or_(
                Dataset.profile["refresh_failed_version"].is_(None),
                _profile_version("refresh_failed_version") < PROFILE_VERSION,
            ),
        )
        .order_by(Dataset.id)
        .limit(1)
        .with_for_update(skip_locked=True)
    ).first()
    if dataset is None:
        db.rollback()
        return False
    dataset_id = dataset.id
    try:
        profile, records = _profile_and_records(dataset, settings)
        _store_records(db, dataset_id, records)
        dataset.profile = profile
        db.commit()
        log.info("Dataset %d profile refreshed to version %d", dataset_id, PROFILE_VERSION)
    except Exception:
        log.exception("Refreshing the profile of dataset %d failed", dataset_id)
        db.rollback()  # the old profile and records stay as they were
        failed = db.get(Dataset, dataset_id, with_for_update=True)
        if failed is not None:
            failed.profile = {**(failed.profile or {}), "refresh_failed_version": PROFILE_VERSION}
        db.commit()
    return True


def run_once(db: Session, settings: Settings) -> bool:
    """One worker iteration: profile at most one pending dataset (fast), then
    execute at most one queued run. Returns True if anything was processed."""
    profiled = profile_next_dataset(db, settings)
    run = claim_next_run(db)
    if run is not None:
        execute_run(db, run, settings)
    return profiled or run is not None


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    make_session = get_sessionmaker()
    lock = acquire_worker_lock(make_session.kw["bind"])
    if lock is None:
        log.error("Another worker is already running (only one is supported); exiting")
        raise SystemExit(1)

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
    lock.close()
    log.info("Worker stopped")


if __name__ == "__main__":
    main()
