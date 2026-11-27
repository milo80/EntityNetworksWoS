// The assistant's chat: a top-bar button and a panel beside the current page.
// Answers are plain text (rendered as text, never as HTML). The browser sends
// only the conversation (with what earlier replies did: proposal settings, action
// kinds and values) and the ids of the open dataset or network.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMatch, useNavigate } from "react-router";

import {
  ApiError,
  api,
  type ChatContext,
  type ChatMessage,
  type ChatReply,
  type NetworkProposal,
} from "../../api/client";
import { useAssistant, type Entry } from "./AssistantContext";

export const ASSISTANT_STATUS_KEY = ["assistant-status"] as const;
const MAX_CHARS = 2000;
/** Most messages sent per request (the server passes only the last 20 to the model). */
const MAX_SENT = 50;

const PRIVACY =
  "Your messages are sent to Anthropic's Claude. Names and values from your data are not, " +
  "unless you type them.";

/** What the user sees when a request fails (no technical details). */
export function friendlyError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return "You've asked a lot of questions. Please wait a few minutes and try again.";
    }
    if (error.status === 503) return "The assistant is not available on this server.";
    if (error.status === 422) return error.message;
  }
  return "The assistant is not available right now. Please try again later.";
}

/** Whether the server has the assistant on (no button otherwise). */
export function useAssistantEnabled(): boolean {
  const status = useQuery({
    queryKey: ASSISTANT_STATUS_KEY,
    queryFn: api.assistantStatus,
    staleTime: Infinity,
    retry: false,
  });
  return status.data?.enabled === true;
}

export function AssistantButton() {
  const assistant = useAssistant();
  const enabled = useAssistantEnabled();
  if (!assistant || !enabled) return null;
  return (
    <button
      type="button"
      className={`btn btn-sm${assistant.open ? " btn-pressed" : ""}`}
      aria-expanded={assistant.open}
      aria-controls="assistant-panel"
      onClick={() => assistant.setOpen(!assistant.open)}
    >
      Assistant
    </button>
  );
}

/** The page and the ids of what is open, from the URL (and the open network's run). */
function useChatContext(): ChatContext {
  const datasetId = useMatch("/datasets/:datasetId/*")?.params.datasetId;
  const onData = useMatch("/datasets/:datasetId/data") !== null;
  const onRecords = useMatch("/datasets/:datasetId/records") !== null;
  const onDatasets = useMatch("/datasets") !== null;
  const runId = useMatch("/runs/:runId")?.params.runId;
  const onExploreIndex = useMatch("/explore") !== null;
  const onLocal = useMatch("/local") !== null;
  const run = useQuery({
    queryKey: ["run", Number(runId)],
    queryFn: () => api.getRun(Number(runId)),
    enabled: runId !== undefined,
  });
  if (runId !== undefined) {
    return {
      page: "explorer",
      run_id: Number(runId),
      dataset_id: run.data?.dataset_id ?? null,
    };
  }
  if (datasetId !== undefined) {
    const page = onData ? "data" : onRecords ? "records" : "dataset";
    return { page, dataset_id: Number(datasetId), run_id: null };
  }
  // A local file is open in the explorer: the server can't see it, so chat can't drive it.
  if (onLocal) return { page: "local", dataset_id: null, run_id: null };
  if (onExploreIndex) return { page: "explorer", dataset_id: null, run_id: null };
  return { page: onDatasets ? "datasets" : "other", dataset_id: null, run_id: null };
}

/**
 * One message as sent: its text and, for a reply, what it did here (its proposal and
 * whether that filled in the Build network form, and the explorer actions applied).
 * Never the panel's action lines: "Selected <node name>" would send a node's name.
 */
function toMessage(e: Entry): ChatMessage {
  if (e.role !== "assistant") return { role: "user", text: e.text };
  const message: ChatMessage = { role: "assistant", text: e.text };
  if (e.proposal) {
    message.proposal = e.proposal;
    message.proposal_filled_form = e.proposalApplied === true;
  }
  if (e.actions?.length) message.actions = e.actions;
  return message;
}

let nextId = 1;

export function AssistantPanel() {
  const assistant = useAssistant();
  const enabled = useAssistantEnabled();
  const context = useChatContext();
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);
  // "New conversation" starts a new epoch: a late answer to the old one is dropped.
  const epoch = useRef(0);

  const send = useMutation({
    mutationFn: ({
      history,
      context: sentContext,
    }: {
      history: Entry[];
      context: ChatContext;
      userId: number;
      epoch: number;
    }) =>
      api.chat(
        history
          .filter((e) => e.role !== "error" && !e.failed)
          .slice(-MAX_SENT)
          .map(toMessage),
        sentContext,
      ),
    onSuccess: (reply: ChatReply, sent) => {
      if (!assistant || sent.epoch !== epoch.current) return;
      const actions = reply.actions ?? [];
      // Only to the network the question was about, if its explorer is still open.
      const result = actions.length
        ? assistant.applyActions(sent.context.run_id ?? null, actions)
        : null;
      const lines = actions.length
        ? (result?.lines ?? ["Open the network in the explorer to apply these changes."])
        : undefined;
      const applied = reply.proposal ? assistant.applyProposal(reply.proposal) : false;
      assistant.setEntries((entries) => [
        ...entries,
        {
          id: nextId++,
          role: "assistant",
          text: reply.reply,
          proposal: reply.proposal ?? null,
          proposalApplied: applied,
          lines,
          // Only what took effect is sent back (never the lines: they may name nodes).
          actions: result?.applied,
        },
      ]);
    },
    onError: (error, { userId, epoch: sentIn }) => {
      if (sentIn !== epoch.current) return;
      assistant?.setEntries((entries) => [
        ...entries.map((e) => (e.id === userId ? { ...e, failed: true } : e)),
        { id: nextId++, role: "error", text: friendlyError(error) },
      ]);
    },
  });

  const entries = assistant?.entries ?? [];
  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [entries.length, send.isPending]);

  if (!assistant || !enabled || !assistant.open) return null;

  const question = draft.trim();
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!question || send.isPending) return;
    const entry: Entry = { id: nextId++, role: "user", text: question };
    const history = [...entries, entry];
    assistant.setEntries(() => history);
    setDraft("");
    send.mutate({ history, context, userId: entry.id, epoch: epoch.current });
  };

  const openInBuildForm = (proposal: NetworkProposal, entryId: number) => {
    if (!assistant.applyProposal(proposal)) {
      assistant.setPending(proposal);
      navigate(`/datasets/${proposal.dataset_id}`);
    }
    assistant.setEntries((list) =>
      list.map((e) => (e.id === entryId ? { ...e, proposalApplied: true } : e)),
    );
  };

  return (
    <aside id="assistant-panel" className="assistant" aria-label="Assistant">
      <div className="assistant-head">
        <h2>Assistant</h2>
        <div className="assistant-head-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={entries.length === 0 && !send.isPending}
            onClick={() => {
              epoch.current += 1;
              send.reset();
              assistant.clear();
            }}
          >
            New conversation
          </button>
          <button type="button" className="btn btn-sm" onClick={() => assistant.setOpen(false)}>
            Close
          </button>
        </div>
      </div>

      <div className="assistant-log" ref={log} role="log" aria-label="Conversation">
        {entries.length === 0 && (
          <p className="small muted">
            Ask what entities, links, models or filters mean, describe the network you want, or say
            what to show in the explorer.
          </p>
        )}
        {entries.map((e) => (
          <ChatEntry key={e.id} entry={e} onOpen={(p) => openInBuildForm(p, e.id)} />
        ))}
        {send.isPending && (
          <p className="chat-msg chat-assistant muted" role="status">
            Thinking…
          </p>
        )}
      </div>

      <form className="assistant-form" onSubmit={submit} aria-label="Ask the assistant">
        <p className="small muted">{PRIVACY}</p>
        <label htmlFor="assistant-message" className="visually-hidden">
          Message
        </label>
        <textarea
          id="assistant-message"
          className="input assistant-input"
          rows={3}
          maxLength={MAX_CHARS}
          placeholder="Ask a question…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) submit(e);
          }}
        />
        <div className="assistant-send">
          <span className="small muted" aria-live="polite">
            {draft.length > MAX_CHARS - 200 ? `${draft.length} / ${MAX_CHARS}` : ""}
          </span>
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={!question || send.isPending}
          >
            Send
          </button>
        </div>
      </form>
    </aside>
  );
}

function ChatEntry({ entry, onOpen }: { entry: Entry; onOpen: (p: NetworkProposal) => void }) {
  if (entry.role === "error") {
    return (
      <p className="chat-msg chat-error error" role="alert">
        {entry.text}
      </p>
    );
  }
  if (entry.role === "user") {
    return <p className="chat-msg chat-user">{entry.text}</p>;
  }
  return (
    <div className="chat-msg chat-assistant">
      {/* Plain text: React renders it as text, so HTML in it is shown, never run. */}
      <p className="chat-text">{entry.text}</p>
      {entry.lines && entry.lines.length > 0 && (
        <ul className="chat-lines small" aria-label="Applied in the explorer">
          {entry.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {entry.proposal && (
        <div className="chat-proposal small">
          <p>{entry.proposal.summary}</p>
          {entry.proposalApplied ? (
            <p className="muted">Filled in the Build network form.</p>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => onOpen(entry.proposal!)}>
              Open in Build form
            </button>
          )}
        </div>
      )}
    </div>
  );
}
