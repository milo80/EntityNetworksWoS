"""Request/response models for the REST API."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

# ---------------------------------------------------------------- auth


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class Registration(Credentials):
    password: str = Field(min_length=10, max_length=256)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str
    role: str
    created_at: datetime


class SessionOut(BaseModel):
    user: UserOut
    csrf_token: str = Field(description="Send back in the X-CSRF-Token header on "
                                        "POST/PUT/PATCH/DELETE (also set as a readable cookie).")


# ---------------------------------------------------------------- datasets


class DatasetFileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    original_name: str
    size_bytes: int
    sha256: str


class DatasetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    created_at: datetime
    files: list[DatasetFileOut]


# ---------------------------------------------------------------- runs
# Defaults mirror pipeline.relations.*Params (a test enforces this). Upper
# bounds on top_n reflect the browser's comfortable rendering limit.


class _Params(BaseModel):
    model_config = ConfigDict(extra="forbid")
    max_authors: int = Field(15, ge=2, le=200, description="Drop articles with more authors")
    max_team_categories: int = Field(10, ge=1, le=50)
    min_team_size: int = Field(2, ge=1, le=1000)


class AuthorParams(_Params):
    top_n: int = Field(700, ge=10, le=2000)
    team_attribute: Literal["country", "institution", "institution_department"] | None = "country"
    max_team_categories: int = Field(22, ge=1, le=50)


class InstitutionKeywordParams(_Params):
    group_column: Literal["institution_department", "institution", "country"] = \
        "institution_department"
    max_keyword_df: float = Field(0.12, gt=0, le=1,
                                  description="Ignore keywords in more than this share of articles")
    min_shared_keywords: int = Field(3, ge=1, le=50)
    top_n: int = Field(150, ge=10, le=2000)
    team_attribute: Literal["country", "institution"] | None = "country"
    max_team_categories: int = Field(12, ge=1, le=50)


class AuthorRunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dataset_id: int
    relation: Literal["author"]
    params: AuthorParams = AuthorParams()


class InstitutionKeywordRunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dataset_id: int
    relation: Literal["institution_keywords"]
    params: InstitutionKeywordParams = InstitutionKeywordParams()


RunCreate = Annotated[AuthorRunCreate | InstitutionKeywordRunCreate,
                      Field(discriminator="relation")]

PARAMS_BY_RELATION: dict[str, type[_Params]] = {
    "author": AuthorParams,
    "institution_keywords": InstitutionKeywordParams,
}


class RunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    dataset_id: int
    relation: str
    params: dict
    status: Literal["queued", "running", "succeeded", "failed"]
    error: str | None
    node_count: int | None
    edge_count: int | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
