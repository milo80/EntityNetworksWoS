"""Request/response models of the assistant (POST /api/assistant/chat).

The explorer actions double as the input of the model's UI tools: each tool's
input schema is its action without ``kind`` (services/assistant/tools.py), and
the model's input is validated against these models before it reaches the
browser.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .api import EntityName, LinkName, ModelName

MAX_MESSAGE_CHARS = 2000
"""Longest message a user may send."""
MAX_REPLY_CHARS = 20_000
"""Longest earlier assistant reply the browser may send back."""
MAX_HISTORY = 200
"""Most messages one request may carry (only the last 20 reach the model)."""


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=MAX_REPLY_CHARS)


Page = Literal["datasets", "dataset", "data", "records", "explorer", "local", "other"]
"""Where the user is; "local" is the explorer showing a local file (never uploaded)."""


class ChatContext(BaseModel):
    """Where the user is: the page and the ids of what is open (never its content)."""

    model_config = ConfigDict(extra="forbid")
    page: Page = "other"
    dataset_id: int | None = None
    run_id: int | None = None


class ChatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: list[ChatMessage] = Field(
        min_length=1, max_length=MAX_HISTORY, description="The conversation, oldest first"
    )
    context: ChatContext = ChatContext()


# ---------------------------------------------------------------- explorer actions


class _Action(BaseModel):
    # strict: "5" is not a number of groups.
    model_config = ConfigDict(extra="forbid", strict=True)


Count = Annotated[int, Field(ge=1, le=10_000)]
Name = Annotated[str, Field(min_length=1, max_length=200)]


class KeepLargestGroups(_Action):
    """Check the n largest groups (legend order, not 'other'/'unknown'); uncheck the rest."""

    kind: Literal["keep_largest_groups"]
    n: Count


class GroupsByRank(_Action):
    """Check the groups at these legend ranks (1 = largest); uncheck the rest."""

    kind: Literal["groups_by_rank"]
    ranks: list[Count] = Field(min_length=1, max_length=50)


class SetRelations(_Action):
    """Show or hide the links of these relation types."""

    kind: Literal["set_relations"]
    relations: list[Name] = Field(min_length=1, max_length=50)
    visible: bool


class SetWeightRange(_Action):
    """Show links with a weight in [min, max]; null = no bound on that side."""

    kind: Literal["set_weight_range"]
    min: int | None = Field(ge=0)
    max: int | None = Field(ge=0)

    @model_validator(mode="after")
    def _ordered(self) -> SetWeightRange:
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("min is above max")
        return self


class SetHideUnlinked(_Action):
    """Turn 'Hide nodes without visible links' on or off."""

    kind: Literal["set_hide_unlinked"]
    on: bool


class AddAttributeFilter(_Action):
    """Add (or replace) an attribute search row and apply it."""

    kind: Literal["add_attribute_filter"]
    target: Literal["nodes", "links"]
    attribute: Name
    values: list[Name] = Field(min_length=1, max_length=20)


class SetSearch(_Action):
    """Set the 'Find by node name' text (empty clears it)."""

    kind: Literal["set_search"]
    text: str = Field(max_length=200)


class SelectMatch(_Action):
    """Select the n-th node matching the name search (1 = first)."""

    kind: Literal["select_match"]
    n: Count


class Fit(_Action):
    """Fit the view to the visible graph."""

    kind: Literal["fit"]


class Reset(_Action):
    """Return the explorer to how it opened."""

    kind: Literal["reset"]


ExplorerAction = Annotated[
    KeepLargestGroups
    | GroupsByRank
    | SetRelations
    | SetWeightRange
    | SetHideUnlinked
    | AddAttributeFilter
    | SetSearch
    | SelectMatch
    | Fit
    | Reset,
    Field(discriminator="kind"),
]


# ---------------------------------------------------------------- network proposal


class NetworkProposal(BaseModel):
    """Custom-network settings a custom run accepts, for the user to check and build.

    Threshold fields the model doesn't use are null.
    """

    dataset_id: int
    entity: EntityName
    link: LinkName
    model: ModelName
    top_n: int
    min_weight: int
    min_shared: int | None
    max_item_df: float | None
    threshold: float | None
    max_word_df: float | None
    summary: str = Field(description="One line, e.g. 'Institution linked by Keywords, ...'")


class ChatOut(BaseModel):
    reply: str = Field(description="Plain text")
    proposal: NetworkProposal | None = None
    actions: list[ExplorerAction] = Field(
        default_factory=list, description="Explorer changes, to apply in order"
    )


class AssistantStatusOut(BaseModel):
    enabled: bool
