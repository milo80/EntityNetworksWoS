"""POST /api/assistant/chat against a scripted stand-in for the Claude API."""

from __future__ import annotations

import json
import logging

import anthropic
import httpx2
import pytest
from pydantic import SecretStr
from sqlalchemy import select, text

from app.api.assistant import get_model_client
from app.models import NetworkRun
from app.services.assistant import chat as chat_service
from app.services.assistant.guide import SYSTEM_PROMPT
from app.services.assistant.tools import TOOLS
from app.worker import profile_next_dataset, run_once

from ..assistant_fake import REQUEST, FakeModel, refusal, tools
from ..assistant_fake import text as reply
from ..fixtures.synthetic_wos import synthetic_wos_df
from .conftest import register, upload

KEY = "sk-ant-test-0123456789-DO-NOT-LEAK"
PROPOSAL = {
    "entity": "institution",
    "link": "keywords",
    "model": "word_matching",
    "top_n": 200,
    "min_weight": 2,
    "min_shared": 4,
    "max_item_df": 0.1,
    "threshold": None,
    "max_word_df": None,
}


@pytest.fixture
def fake(app, settings):
    """The assistant on, with a scripted model: queue its turns on .turns."""
    settings.anthropic_api_key = SecretStr(KEY)
    model = FakeModel(default=reply("OK."))
    app.dependency_overrides[get_model_client] = lambda: model
    yield model
    app.dependency_overrides.pop(get_model_client, None)


@pytest.fixture
def synthetic(monkeypatch):
    monkeypatch.setattr("app.worker.read_wos_files", lambda files: synthetic_wos_df())
    monkeypatch.setattr("app.services.runs.read_wos_files", lambda files: synthetic_wos_df())


def _profiled_dataset(client, db, settings, name="Unpublished cohort Zyxq"):
    files = [
        (
            "files",
            (
                "secret_export_zyxq.xls",
                b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 4088,
                "application/vnd.ms-excel",
            ),
        )
    ]
    ds = upload(client, name=name, files=files).json()
    assert profile_next_dataset(db, settings) is True
    return ds


def _built_run(client, db, settings, dataset_id):
    params = {"entity": "institution", "link": "keywords", "min_shared": 1, "max_item_df": 1}
    run = client.post(
        "/api/runs", json={"dataset_id": dataset_id, "relation": "custom", "params": params}
    ).json()
    assert run_once(db, settings) is True
    assert client.get(f"/api/runs/{run['id']}").json()["status"] == "succeeded"
    return run


@pytest.fixture
def dataset(client, db, settings, synthetic):
    return _profiled_dataset(client, db, settings)


@pytest.fixture
def run(client, db, settings, dataset):
    return _built_run(client, db, settings, dataset["id"])


def ask(client, question="Hi", *, messages=None, **context):
    body = {
        "messages": messages or [{"role": "user", "text": question}],
        "context": context or {"page": "other"},
    }
    return client.post("/api/assistant/chat", json=body)


# ---------------------------------------------------------------- REQ-AST-1


def test_chat_answers_a_logged_in_user(client, fake):
    fake.turns = [reply("A link model decides when two nodes are linked.")]
    r = ask(client, "What does a link model mean?", page="datasets")
    assert r.status_code == 200, r.text
    assert r.json() == {
        "reply": "A link model decides when two nodes are linked.",
        "proposal": None,
        "actions": [],
    }

    (call,) = fake.calls
    assert call["model"] == "claude-haiku-5-5"
    assert call["thinking"] == {"type": "adaptive"}
    assert call["output_config"] == {"effort": "low"}
    assert call["tool_choice"] == {"type": "auto"}
    assert 0 < call["timeout"] <= 30
    # The static prefix: tools, then the cached system prompt.
    assert call["tools"] == TOOLS
    assert call["system"] == [
        {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}
    ]
    # The page and ids ride on the latest user message, not the system prompt.
    (message,) = call["messages"]
    assert message["role"] == "user"
    assert [b["text"] for b in message["content"]] == [
        "[App context, not typed by the user] page: datasets; no network open",
        "What does a link model mean?",
    ]
    assert client.get("/api/assistant/status").json() == {"enabled": True}


def test_chat_needs_login_and_csrf(make_client, fake):
    anonymous = make_client()
    assert ask(anonymous).status_code == 401
    assert anonymous.get("/api/assistant/status").status_code == 401

    no_csrf = make_client()
    register(no_csrf)
    del no_csrf.headers["X-CSRF-Token"]
    r = ask(no_csrf)
    assert r.status_code == 403 and r.json()["detail"] == "Missing or invalid CSRF token"
    assert fake.calls == []


def _database_dump(db) -> str:
    tables = db.scalars(
        text(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' "
            "AND tablename <> 'alembic_version' ORDER BY tablename"
        )
    ).all()
    return json.dumps(
        {
            t: db.scalars(text(f'SELECT row_to_json(t)::text FROM "{t}" t ORDER BY 1')).all()
            for t in tables
        }
    )


def _files(settings) -> list[str]:
    root = settings.upload_dir
    return sorted(str(p.relative_to(root)) for p in root.rglob("*")) if root.exists() else []


def test_chat_stores_nothing_on_the_server(client, fake, db, settings, run):
    db.commit()
    before, files = _database_dump(db), _files(settings)
    question = "Which groups are the largest? Qwertyuiop question"
    fake.turns = [
        tools(("describe_network", {"run_id": None}), ("keep_largest_groups", {"n": 2})),
        reply("Asdfghjkl answer"),
    ]
    r = ask(client, question, page="explorer", dataset_id=run["dataset_id"], run_id=run["id"])
    assert r.status_code == 200, r.text

    db.expire_all()
    after = _database_dump(db)
    assert after == before
    assert "Qwertyuiop" not in after and "Asdfghjkl" not in after
    assert _files(settings) == files


# ---------------------------------------------------------------- REQ-AST-2


def test_chat_returns_a_network_proposal_for_the_open_dataset(client, fake, dataset):
    fake.turns = [
        tools(("get_network_options", {"dataset_id": None})),
        tools(("propose_network", PROPOSAL)),
        reply("Here is a proposal: check it in the Build network form."),
    ]
    r = ask(client, "Institutions that share keywords", page="data", dataset_id=dataset["id"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["proposal"] == {
        **PROPOSAL,
        "dataset_id": dataset["id"],
        "summary": "Institution (all authors) linked by Keywords (author keywords + "
        "Keywords Plus), word matching, at least 4 shared, links of weight 2 or more, "
        "up to 200 nodes",
    }
    assert body["actions"] == []
    options, proposed = fake.tool_results()
    assert not options["is_error"] and json.loads(options["content"])["articles"] == 6
    assert not proposed["is_error"]
    assert "Nothing is built" in proposed["content"]


def test_invalid_proposal_is_not_returned(client, fake, dataset):
    fake.turns = [
        tools(
            ("propose_network", {**PROPOSAL, "min_shared": 99}),
            ("propose_network", {**PROPOSAL, "entity": "journal", "link": "same_article"}),
            ("propose_network", {**PROPOSAL, "link": "abstract", "model": "character_similarity"}),
            ("propose_network", {**PROPOSAL, "top_n": "many"}),
        ),
        reply("Those settings don't fit: at most 50 shared items."),
    ]
    r = ask(client, "Make a network", page="dataset", dataset_id=dataset["id"])
    assert r.status_code == 200, r.text
    assert r.json()["proposal"] is None
    assert r.json()["reply"] == "Those settings don't fit: at most 50 shared items."
    results = fake.tool_results()
    assert [res["is_error"] for res in results] == [True, True, True, True]
    assert "min_shared" in results[0]["content"] and "50" in results[0]["content"]
    assert "never co-occurs" in results[1]["content"]
    assert "can be compared with" in results[2]["content"]
    assert "top_n" in results[3]["content"]


def test_proposal_must_be_available_for_the_dataset(client, fake, dataset):
    # The synthetic export has no Funding Orgs column.
    fake.turns = [
        tools(("propose_network", {**PROPOSAL, "entity": "funder"})),
        tools(("propose_network", {**PROPOSAL, "link": "funders"})),
        reply("This dataset has no Funding Orgs."),
    ]
    r = ask(client, "Funders that share keywords", page="dataset", dataset_id=dataset["id"])
    assert r.status_code == 200, r.text
    assert r.json()["proposal"] is None
    for result in fake.tool_results():
        assert result["is_error"]
        assert "Funding Orgs is empty or missing in this dataset" in result["content"]

    # Without an open dataset there is nothing to propose for.
    fake.turns = [tools(("propose_network", PROPOSAL)), reply("Open a dataset first.")]
    r = ask(client, "Make a network", page="datasets")
    assert r.json()["proposal"] is None
    assert "No dataset is open" in fake.tool_results()[-1]["content"]


def test_chat_never_creates_a_run(client, fake, db, run):
    def runs():
        db.expire_all()
        return [(r.id, r.status, r.params) for r in db.scalars(select(NetworkRun))]

    before = runs()
    fake.turns = [
        tools(("list_runs", {"dataset_id": None}), ("propose_network", PROPOSAL)),
        tools(("describe_network", {"run_id": run["id"]})),
        reply("Proposed; click Build to build it."),
    ]
    r = ask(
        client, "Build it now!", page="explorer", dataset_id=run["dataset_id"], run_id=run["id"]
    )
    assert r.status_code == 200 and r.json()["proposal"] is not None
    listed = json.loads(fake.tool_results()[0]["content"])
    assert [x["run_id"] for x in listed["runs"]] == [run["id"]]
    assert runs() == before
    assert client.get("/api/runs").json() == [client.get(f"/api/runs/{run['id']}").json()]


# ---------------------------------------------------------------- REQ-AST-3


def test_explorer_actions_are_validated(client, fake, run):
    valid = [
        ("keep_largest_groups", {"n": 5}),
        ("show_groups_by_rank", {"ranks": [2, 3]}),
        ("set_relations", {"relations": ["shares_keywords_with"], "visible": False}),
        ("set_weight_range", {"min": 2, "max": None}),
        ("set_hide_unlinked", {"on": True}),
        ("add_attribute_filter", {"target": "nodes", "attribute": "country", "values": ["Italy"]}),
        ("set_search", {"text": "parma"}),
        ("select_match", {"n": 1}),
        ("fit_view", {}),
        ("reset_explorer", {}),
    ]
    invalid = [
        ("keep_largest_groups", {"n": "5"}),  # wrong type
        ("keep_largest_groups", {"n": 0}),
        ("show_groups_by_rank", {"ranks": []}),
        ("set_relations", {"relations": ["x"], "visible": "no"}),
        ("set_weight_range", {"min": 5, "max": 2}),
        ("set_hide_unlinked", {}),
        ("add_attribute_filter", {"target": "planet", "attribute": "x", "values": ["y"]}),
        ("set_search", {"text": "x", "color": "red"}),  # unknown field
        ("delete_dataset", {"id": 1}),  # not an action
    ]
    fake.turns = [tools(*valid, *invalid), reply("Done.")]
    r = ask(
        client, "Change the view", page="explorer", dataset_id=run["dataset_id"], run_id=run["id"]
    )
    assert r.status_code == 200, r.text
    assert r.json()["actions"] == [
        {"kind": "keep_largest_groups", "n": 5},
        {"kind": "groups_by_rank", "ranks": [2, 3]},
        {"kind": "set_relations", "relations": ["shares_keywords_with"], "visible": False},
        {"kind": "set_weight_range", "min": 2, "max": None},
        {"kind": "set_hide_unlinked", "on": True},
        {
            "kind": "add_attribute_filter",
            "target": "nodes",
            "attribute": "country",
            "values": ["Italy"],
        },
        {"kind": "set_search", "text": "parma"},
        {"kind": "select_match", "n": 1},
        {"kind": "fit"},
        {"kind": "reset"},
    ]
    results = fake.tool_results()
    assert [res["is_error"] for res in results] == [False] * len(valid) + [True] * len(invalid)
    assert "Unknown tool" in results[len(valid) + 8]["content"]


def test_no_explorer_actions_without_an_open_network(make_client, client, fake, db, settings, run):
    other = make_client()
    register(other, "bob@example.org")
    theirs = _built_run(other, db, settings, _profiled_dataset(other, db, settings)["id"])
    for context in [
        {"page": "dataset", "dataset_id": run["dataset_id"]},
        {"page": "explorer", "run_id": theirs["id"]},  # not the user's network
        {"page": "explorer", "run_id": 999_999},
    ]:
        fake.turns = [
            tools(("keep_largest_groups", {"n": 2}), ("fit_view", {})),
            reply("Open a network first."),
        ]
        r = ask(client, "Only the two largest groups", **context)
        assert r.status_code == 200 and r.json()["actions"] == []
        assert all(res["is_error"] for res in fake.tool_results()[-2:])
        assert "No network is open" in fake.tool_results()[-1]["content"]


# ---------------------------------------------------------------- REQ-AST-4


def _values(value) -> set[str]:
    if isinstance(value, str):
        return {value}
    if isinstance(value, dict):
        return set().union(set(), *(_values(v) for v in value.values()))
    if isinstance(value, list):
        return set().union(set(), *(_values(v) for v in value))
    return set()


def test_no_data_values_reach_the_model(client, fake, db, run, dataset):
    network = client.get(f"/api/runs/{run['id']}/network").json()
    profile = client.get(f"/api/datasets/{dataset['id']}/profile").json()["profile"]
    records = client.get(f"/api/datasets/{dataset['id']}/records").json()["rows"]
    secret = {n["name"] for n in network["nodes"]} | {n["team"] for n in network["nodes"]}
    for item in [*network["nodes"], *network["edges"]]:
        secret |= _values(item.get("attr") or {})
    secret |= _values(profile["sample"]["rows"]) | _values([r["values"] for r in records])
    secret |= {dataset["name"], dataset["files"][0]["original_name"]}
    # Specific values only: not numbers, not 'other'/'unknown', not the app's own words.
    secret = {
        v.strip()
        for s in secret
        for v in [s, *s.split(";")]
        if len(v.strip()) >= 4
        and not v.strip().replace(".", "").isdigit()
        and v.strip() not in ("other", "unknown")
        and v.strip() not in SYSTEM_PROMPT
        and v.strip() not in json.dumps(TOOLS)
    }
    assert {"Univ Parma", "Italy", "fetal ultrasound", "Unpublished cohort Zyxq"} <= secret

    ids = {"dataset_id": dataset["id"]}
    fake.turns = [
        tools(
            ("get_network_options", ids),
            ("list_runs", ids),
            ("describe_network", {"run_id": run["id"]}),
        ),
        tools(
            ("get_network_options", {"dataset_id": None}), ("describe_network", {"run_id": None})
        ),
        tools(
            ("propose_network", PROPOSAL), *[(n, a) for n, a in [("keep_largest_groups", {"n": 1})]]
        ),
        reply("Done."),
    ]
    question = "Show only Fudan Univ please"  # typed by the user: sent as typed
    r = ask(client, question, page="explorer", dataset_id=dataset["id"], run_id=run["id"])
    assert r.status_code == 200, r.text
    assert len(fake.calls) == 4 and not any(res["is_error"] for res in fake.tool_results())

    for call in fake.calls:
        assert call["system"][0]["text"] == SYSTEM_PROMPT and call["tools"] == TOOLS
    sent = fake.sent_messages()
    assert question in sent
    leaked = sorted(v for v in secret if v in sent.replace(question, ""))
    assert leaked == []


def test_tools_only_see_the_users_own_data(make_client, client, fake, db, settings, dataset, run):
    other = make_client()
    register(other, "bob@example.org")
    their_dataset = _profiled_dataset(other, db, settings, name="Bob data")
    their_run = _built_run(other, db, settings, their_dataset["id"])

    def results_for(dataset_id, run_id):
        fake.turns = [
            tools(
                ("get_network_options", {"dataset_id": dataset_id}),
                ("list_runs", {"dataset_id": dataset_id}),
                ("describe_network", {"run_id": run_id}),
            ),
            reply("OK."),
        ]
        assert ask(client, "Tell me", page="other").status_code == 200
        return [(res["content"], res["is_error"]) for res in fake.tool_results()[-3:]]

    theirs = results_for(their_dataset["id"], their_run["id"])
    missing = results_for(999_999, 999_998)
    assert (
        theirs
        == missing
        == [
            ("Dataset not found.", True),
            ("Dataset not found.", True),
            ("Network not found.", True),
        ]
    )
    mine = results_for(dataset["id"], run["id"])
    assert [is_error for _, is_error in mine] == [False, False, False]

    # As the open dataset or network: the same.
    fake.turns = [
        tools(
            ("get_network_options", {"dataset_id": None}), ("describe_network", {"run_id": None})
        ),
        reply("OK."),
    ]
    ask(client, "Tell me", page="explorer", dataset_id=their_dataset["id"], run_id=their_run["id"])
    assert [res["content"] for res in fake.tool_results()[-2:]] == [
        "Dataset not found.",
        "Network not found.",
    ]


# ---------------------------------------------------------------- REQ-AST-5


def test_chat_is_503_without_an_api_key(client, app, settings):
    settings.anthropic_api_key = None
    model = FakeModel()
    app.dependency_overrides[get_model_client] = lambda: model
    try:
        r = ask(client, "Hello")
    finally:
        app.dependency_overrides.pop(get_model_client, None)
    assert r.status_code == 503
    assert r.json() == {"detail": "The assistant is not available on this server."}
    assert model.calls == []
    assert client.get("/api/assistant/status").json() == {"enabled": False}
    # Compose passes an empty ANTHROPIC_API_KEY when it isn't set.
    from app.config import Settings

    assert Settings(anthropic_api_key="").assistant_enabled is False
    assert Settings(anthropic_api_key=KEY).assistant_enabled is True


def test_chat_is_rate_limited_per_user(make_client, client, fake):
    for _ in range(30):
        assert ask(client).status_code == 200
    r = ask(client)
    assert r.status_code == 429
    assert r.json() == {
        "detail": "You've asked a lot of questions. Please wait a few minutes and try again."
    }
    assert len(fake.calls) == 30
    other = make_client()
    register(other, "bob@example.org")
    assert ask(other).status_code == 200


def test_chat_rejects_long_messages(client, fake):
    r = ask(client, "x" * 2001)
    assert r.status_code == 422
    assert r.json() == {"detail": "Your message is too long (at most 2000 characters)."}
    earlier = [{"role": "user", "text": "y" * 2001}, {"role": "assistant", "text": "ok"}]
    r = ask(client, messages=[*earlier, {"role": "user", "text": "short"}])
    assert r.status_code == 422
    assert fake.calls == []
    assert ask(client, "x" * 2000).status_code == 200


def _texts(call) -> list[str]:
    return [
        m["content"] if isinstance(m["content"], str) else m["content"][-1]["text"]
        for m in call["messages"]
    ]


def _conversation(n: int, *, resent: int | None = None) -> list[dict]:
    """n messages ending with a question; ``resent``: a question sent twice in a row."""
    roles = []
    for i in range(n):
        from_end = n - 1 - i
        roles.append("user" if from_end % 2 == 0 else "assistant")
    if resent is not None:
        roles[resent] = "user"
    return [{"role": r, "text": f"message {i}"} for i, r in enumerate(roles)]


def test_only_the_last_20_messages_reach_the_model(client, fake):
    # Message 11 is a question resent after an error, so the window starts with it.
    history = _conversation(31, resent=11)
    assert ask(client, messages=history).status_code == 200
    (call,) = fake.calls
    assert _texts(call) == [f"message {i}" for i in range(11, 31)]
    assert call["messages"][0]["role"] == "user"

    # Strictly alternating, the window's first message is a reply: the model starts
    # at the next question (19 messages), never at an older one.
    fake.calls.clear()
    assert ask(client, messages=_conversation(31)).status_code == 200
    assert _texts(fake.calls[0]) == [f"message {i}" for i in range(12, 31)]

    # The browser may send up to 200 messages; the model still gets the last ones.
    fake.calls.clear()
    assert ask(client, messages=_conversation(200)).status_code == 200
    assert _texts(fake.calls[0])[-1] == "message 199"
    assert ask(client, messages=_conversation(201)).status_code == 422


def test_tool_rounds_are_capped_at_5(client, fake, run):
    fake.default = lambda _: tools(("propose_network", PROPOSAL), ("keep_largest_groups", {"n": 1}))
    r = ask(client, "Loop", page="explorer", dataset_id=run["dataset_id"], run_id=run["id"])
    assert r.status_code == 200
    assert r.json() == {
        "reply": "I couldn't finish that. Please ask a simpler or narrower question.",
        "proposal": None,
        "actions": [],
    }
    assert len(fake.calls) == 6  # 5 rounds of tools, then the cap
    assert len(fake.tool_results()) == 10

    # Running out of tokens ends the same way.
    fake.default = None
    fake.turns = [reply("Half an ans", stop_reason="max_tokens")]
    assert ask(client, "Long").json()["reply"] == chat_service.COULD_NOT_FINISH


def test_refusal_gets_a_friendly_reply(client, fake, run):
    fake.turns = [tools(("keep_largest_groups", {"n": 1})), refusal()]
    r = ask(
        client, "Something else", page="explorer", dataset_id=run["dataset_id"], run_id=run["id"]
    )
    assert r.status_code == 200
    assert r.json() == {
        "reply": "Sorry, I can't help with that. I can explain EntityNetworks, suggest network "
        "settings and change the explorer's filters.",
        "proposal": None,
        "actions": [],
    }


def _status_error(cls, code):
    return cls("boom", response=httpx2.Response(code, request=REQUEST), body=None)


@pytest.mark.parametrize(
    "error",
    [
        anthropic.APITimeoutError(request=REQUEST),
        anthropic.APIConnectionError(request=REQUEST),
        _status_error(anthropic.InternalServerError, 500),
        _status_error(anthropic.RateLimitError, 429),
        _status_error(anthropic.AuthenticationError, 401),
        anthropic.AnthropicError("client-side failure"),
    ],
    ids=["timeout", "connection", "500", "429", "401", "client"],
)
def test_model_errors_get_a_friendly_message(client, fake, error):
    fake.turns = [error]
    r = ask(client, "Hello")
    assert r.status_code == 502
    assert r.json() == {
        "detail": "The assistant is not available right now. Please try again later."
    }
    # A later error in the tool loop, too.
    fake.turns = [tools(("list_runs", {"dataset_id": None})), error]
    assert ask(client, "Hello").status_code == 502


def test_answers_have_a_30_second_deadline(client, fake, monkeypatch):
    clock = iter([0.0, 0.0, 31.0])
    monkeypatch.setattr(chat_service, "clock", lambda: next(clock))
    fake.turns = [tools(("list_runs", {"dataset_id": None}))]
    r = ask(client, "Slow")
    assert r.status_code == 502
    assert len(fake.calls) == 1  # no second call after the deadline


def test_api_key_never_leaves_the_server(client, fake, caplog, settings):
    caplog.set_level(logging.DEBUG)
    responses = [client.get("/api/assistant/status"), client.get("/api/auth/me")]
    fake.turns = [reply("Hi.")]
    responses.append(ask(client, "Hello"))
    for error in [
        anthropic.APIConnectionError(request=REQUEST),
        _status_error(anthropic.AuthenticationError, 401),
    ]:
        fake.turns = [error]
        responses.append(ask(client, "Hello"))
    assert [r.status_code for r in responses] == [200, 200, 200, 502, 502]
    for r in responses:
        assert KEY not in r.text
        assert all(KEY not in v for v in r.headers.values())
    assert KEY not in caplog.text
    assert KEY not in repr(settings) and KEY not in str(settings.model_dump())
    assert "can't reach the Claude API" in caplog.text  # errors are logged, without details
    # The real client is built with the key and no retries, bounded by the deadline.
    real = chat_service.make_client(KEY)
    assert isinstance(real, anthropic.Anthropic) and real.max_retries == 0
    assert KEY not in caplog.text


def test_no_transaction_stays_open_while_waiting_for_the_model(client, fake, db, run):
    db.rollback()  # the test's own session holds nothing either

    def idle_in_transaction() -> int:
        with db.get_bind().connect() as conn:
            n = conn.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                    "AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()"
                )
            )
            conn.rollback()
        return int(n or 0)

    seen: list[int] = []

    def turn(result):
        def answer(_kwargs):
            seen.append(idle_in_transaction())
            return result

        return answer

    fake.turns = [
        turn(tools(("describe_network", {"run_id": None}), ("list_runs", {"dataset_id": None}))),
        turn(tools(("get_network_options", {"dataset_id": None}))),
        turn(reply("Done.")),
    ]
    r = ask(client, "Describe it", page="explorer", dataset_id=run["dataset_id"], run_id=run["id"])
    assert r.status_code == 200, r.text
    assert len(fake.tool_results()) == 3
    assert seen == [0, 0, 0]


def test_local_file_context_says_chat_cannot_drive_it(client, fake):
    fake.turns = [reply("Use the filters on the left.")]
    r = ask(client, "Only the largest groups", page="local")
    assert r.status_code == 200, r.text
    first = fake.calls[0]["messages"][-1]["content"][0]["text"]
    assert "a local network file is open in the explorer" in first
    assert "can't be read or changed by chat" in first
    assert 'context page "local"' in SYSTEM_PROMPT
