"""Request/response models for the REST API."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from pipeline.custom import DEFAULT_NODE_ATTRIBUTES, combination_problem

# ---------------------------------------------------------------- auth


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class Registration(Credentials):
    password: str = Field(min_length=10, max_length=256)


class PasswordResetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr


class PasswordResetConfirm(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=10, max_length=256)


class MessageOut(BaseModel):
    detail: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str
    role: str
    created_at: datetime


class SessionOut(BaseModel):
    user: UserOut
    csrf_token: str = Field(
        description="Send back in the X-CSRF-Token header on "
        "POST/PUT/PATCH/DELETE (also set as a readable cookie)."
    )


# ---------------------------------------------------------------- datasets


class DatasetFileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    original_name: str
    size_bytes: int
    sha256: str


ProfileStatus = Literal["pending", "ready", "failed"]


class DatasetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    created_at: datetime
    profile_status: ProfileStatus
    profile_error: str | None
    files: list[DatasetFileOut]


class DatasetProfileOut(BaseModel):
    """Schema, sample rows and statistics (see pipeline/profile.py); null until ready."""

    status: ProfileStatus
    error: str | None
    profile: dict | None


# ---------------------------------------------------------------- records

RECORDS_PAGE_SIZE = 50
RecordOperator = Literal["contains", "not_contains", "has_item", "is_empty", "not_empty"]
RecordValue = str | int | float


class RecordFilter(BaseModel):
    """One filter row. ";" separates alternatives in ``value`` (OR); rows combine with AND."""

    model_config = ConfigDict(extra="forbid")
    column: str = Field(min_length=1, max_length=300)
    op: RecordOperator
    value: str = Field("", max_length=5000, description="Ignored by is_empty / not_empty")


class RecordColumnOut(BaseModel):
    name: str
    derived: bool = Field(description="Computed like the networks do; not in the export")
    type: str = Field(description="text, number, boolean or date (sorting compares numbers)")


class RecordOut(BaseModel):
    index: int = Field(description="0-based position in upload order")
    values: dict[str, RecordValue] = Field(description="Column -> value; empty ones left out")


class RecordsPageOut(BaseModel):
    """One page of a dataset's records; status/error mirror the profile's."""

    status: ProfileStatus
    error: str | None
    columns: list[RecordColumnOut]
    total: int = Field(description="Records in the dataset")
    matching: int = Field(description="Records that match the filters")
    page: int
    page_size: int
    rows: list[RecordOut]
    ignored_filter_columns: list[str] = Field(
        description="Filters on columns the dataset doesn't have, which were dropped"
    )


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
    group_column: Literal["institution_department", "institution", "country"] = (
        "institution_department"
    )
    max_keyword_df: float = Field(
        0.12, gt=0, le=1, description="Ignore keywords in more than this share of articles"
    )
    min_shared_keywords: int = Field(3, ge=1, le=50)
    top_n: int = Field(150, ge=10, le=2000)
    team_attribute: Literal["country", "institution"] | None = "country"
    max_team_categories: int = Field(12, ge=1, le=50)


# Keys of the custom-network catalog (pipeline.custom); a test keeps them in sync.
EntityName = Literal[
    "author",
    "institution",
    "corresponding_institution",
    "country",
    "organization",
    "journal",
    "funder",
    "wos_category",
    "research_area",
    "article",
]
LinkName = Literal[
    "same_article",
    "keywords",
    "author_keywords",
    "keywords_plus",
    "wos_categories",
    "research_areas",
    "funders",
    "organizations",
    "authors",
    "article_title",
    "journal",
    "abstract",
    "funding_text",
]
ModelName = Literal["word_matching", "word_overlap", "character_similarity"]
AttributeField = Annotated[str, Field(min_length=1, max_length=200)]


class CustomParams(_Params):
    entity: EntityName = Field("institution", description="What the nodes are")
    link: LinkName = Field("keywords", description="The field that links them")
    model: ModelName = Field("word_matching", description="How the field is compared")
    min_shared: int = Field(3, ge=1, le=50, description="Word matching: shared items needed")
    max_item_df: float = Field(
        0.05, gt=0, le=1, description="Word matching: ignore items in more than this share"
    )
    threshold: float = Field(
        0.5, gt=0, le=1, description="String similarity: minimum similarity (0-1)"
    )
    max_word_df: float = Field(
        0.05, gt=0, le=1, description="String similarity: ignore words in more than this share"
    )
    min_weight: int = Field(
        1, ge=1, le=1000, description="Keep links with at least this many matched article pairs"
    )
    top_n: int = Field(300, ge=10, le=2000)
    max_team_categories: int = Field(12, ge=1, le=50)
    node_attributes: tuple[AttributeField, ...] = Field(
        DEFAULT_NODE_ATTRIBUTES,
        max_length=200,
        description="Fields added to each node for attribute search: a column name or "
        "a derived field ('country', 'articles'); each node gets the most common values "
        "among its articles. Fields missing from the data are skipped.",
    )

    @model_validator(mode="after")
    def _valid_combination(self) -> CustomParams:
        problem = combination_problem(self.entity, self.link, self.model)
        if problem:
            raise ValueError(problem)
        return self


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


class CustomRunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dataset_id: int
    relation: Literal["custom"]
    params: CustomParams = CustomParams()


RunCreate = Annotated[
    AuthorRunCreate | InstitutionKeywordRunCreate | CustomRunCreate,
    Field(discriminator="relation"),
]

PARAMS_BY_RELATION: dict[str, type[_Params]] = {
    "author": AuthorParams,
    "institution_keywords": InstitutionKeywordParams,
    "custom": CustomParams,
}


# ---------------------------------------------------------------- custom network options


class EntityOption(BaseModel):
    key: EntityName
    label: str
    many_per_article: bool
    available: bool
    reason: str | None = Field(description="Why it isn't available in this dataset")
    links: list[LinkName] = Field(description="Link fields this entity can be linked by")


class LinkOption(BaseModel):
    key: LinkName
    label: str
    kind: Literal["same_article", "list", "string"]
    models: list[ModelName]
    available: bool
    reason: str | None


class AttributeOption(BaseModel):
    key: str = Field(description="What node_attributes takes: a column name or a derived field")
    label: str
    attr_key: str = Field(description="The key it gets in a node's attr")
    fill_pct: float | None = Field(description="% of articles with a value (from the profile)")
    not_for: list[EntityName] = Field(
        description="Entities whose nodes come from this same field (not added to them)"
    )


class ModelOption(BaseModel):
    key: ModelName
    label: str
    description: str
    threshold_default: float | None = Field(
        description="Default for 'threshold' with this model (string similarity only)"
    )


class NetworkOptionsOut(BaseModel):
    entities: list[EntityOption]
    links: list[LinkOption]
    models: list[ModelOption]
    attributes: list[AttributeOption] = Field(
        description="Every field a node attribute can come from: derived ones, then the "
        "dataset's columns (only the defaults while the profile isn't ready)"
    )
    defaults: CustomParams


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
