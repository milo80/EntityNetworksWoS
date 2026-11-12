"""Saving uploaded WoS files to disk.

Files are stored as <upload_dir>/<dataset_id>/<random hex>.xls - never under a
user-supplied name. Each file is streamed to disk in chunks with the size limit
enforced while reading, and must start with the OLE2 signature that legacy
.xls files (what WoS exports) carry. Contents are parsed only by the worker.
"""

from __future__ import annotations

import hashlib
import secrets
import shutil
from dataclasses import dataclass
from pathlib import Path

from fastapi import UploadFile

OLE2_SIGNATURE = bytes.fromhex("D0CF11E0A1B11AE1")
ALLOWED_SUFFIXES = (".xls",)
CHUNK = 1024 * 1024


class UploadRejected(ValueError):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class StoredFile:
    original_name: str
    stored_name: str
    size_bytes: int
    sha256: str


def dataset_dir(upload_dir: Path, dataset_id: int) -> Path:
    return upload_dir / str(dataset_id)


def _clean_name(name: str | None) -> str:
    base = Path(name or "").name.strip()  # drop any client-side path components
    return base[:255] or "upload.xls"


def save_upload(upload: UploadFile, target_dir: Path, max_bytes: int) -> StoredFile:
    original = _clean_name(upload.filename)
    if not original.lower().endswith(ALLOWED_SUFFIXES):
        raise UploadRejected(f"{original}: only WoS .xls exports are supported", 415)

    target_dir.mkdir(parents=True, exist_ok=True)
    stored_name = f"{secrets.token_hex(16)}.xls"
    path = target_dir / stored_name
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("wb") as out:
            first = True
            while chunk := upload.file.read(CHUNK):
                if first:
                    if not chunk.startswith(OLE2_SIGNATURE):
                        raise UploadRejected(f"{original}: not a legacy Excel (.xls) file", 415)
                    first = False
                size += len(chunk)
                if size > max_bytes:
                    raise UploadRejected(
                        f"{original}: larger than {max_bytes // (1024 * 1024)} MB", 413)
                digest.update(chunk)
                out.write(chunk)
        if size == 0:
            raise UploadRejected(f"{original}: empty file")
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return StoredFile(original, stored_name, size, digest.hexdigest())


def remove_dataset_dir(upload_dir: Path, dataset_id: int) -> None:
    shutil.rmtree(dataset_dir(upload_dir, dataset_id), ignore_errors=True)
