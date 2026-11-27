// The assistant's state for the logged-in app: the conversation (kept in this
// tab's memory only, so it survives moving between pages and is gone after a
// logout or reload), whether the panel is open, and the pages that can act on a
// reply: the explorer (actions) and a dataset's Build network form (proposals).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ExplorerAction, NetworkProposal } from "../../api/client";

export interface Entry {
  id: number;
  role: "user" | "assistant" | "error";
  text: string;
  /** A user message whose request failed: shown, but not sent again. */
  failed?: boolean;
  proposal?: NetworkProposal | null;
  /** The proposal was put into its dataset's Build network form. */
  proposalApplied?: boolean;
  /** One line per explorer action that was applied (shown only: lines may name nodes). */
  lines?: string[];
  /** The explorer actions that were applied, sent back with the conversation. */
  actions?: ExplorerAction[];
}

/** What applying explorer actions did: the lines shown, and the actions that took effect. */
export interface AppliedActions {
  lines: string[];
  applied: ExplorerAction[];
}

/** Applies explorer actions in order. */
export type ExplorerHandler = (actions: ExplorerAction[]) => AppliedActions;
/** Fills a Build network form with a proposal. */
export type ProposalHandler = (proposal: NetworkProposal) => void;

interface AssistantValue {
  entries: Entry[];
  setEntries: (update: (entries: Entry[]) => Entry[]) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Empty the conversation (New conversation, logout). */
  clear: () => void;
  /**
   * Apply actions to the explorer of network `runId` (the one open when the
   * message was sent); null when that network's explorer isn't open.
   */
  applyActions: (runId: number | null, actions: ExplorerAction[]) => AppliedActions | null;
  /** Fill the open Build network form of the proposal's dataset; false when none is open. */
  applyProposal: (proposal: NetworkProposal) => boolean;
  /** Keep a proposal for the Build network form that opens next for its dataset. */
  setPending: (proposal: NetworkProposal) => void;
  /** `runId` is null for a local file (never driven by chat). */
  registerExplorer: (runId: number | null, handler: ExplorerHandler) => () => void;
  registerBuildForm: (datasetId: number, handler: ProposalHandler) => () => void;
}

const AssistantContext = createContext<AssistantValue | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [entries, setEntriesState] = useState<Entry[]>([]);
  const [open, setOpen] = useState(false);
  const explorer = useRef<{ runId: number | null; handler: ExplorerHandler } | null>(null);
  const forms = useRef(new Map<number, ProposalHandler>());
  const pending = useRef<NetworkProposal | null>(null);

  // Stable across renders, so pages register once.
  const actions = useMemo(
    () => ({
      setEntries: (update: (entries: Entry[]) => Entry[]) => setEntriesState(update),
      clear: () => {
        setEntriesState([]);
        pending.current = null;
      },
      applyActions: (runId: number | null, list: ExplorerAction[]) => {
        const open = explorer.current;
        if (runId === null || !open || open.runId !== runId) return null;
        return open.handler(list);
      },
      applyProposal: (proposal: NetworkProposal) => {
        const form = forms.current.get(proposal.dataset_id);
        if (!form) return false;
        form(proposal);
        return true;
      },
      setPending: (proposal: NetworkProposal) => {
        pending.current = proposal;
      },
      registerExplorer: (runId: number | null, handler: ExplorerHandler) => {
        const entry = { runId, handler };
        explorer.current = entry;
        return () => {
          if (explorer.current === entry) explorer.current = null;
        };
      },
      registerBuildForm: (datasetId: number, handler: ProposalHandler) => {
        forms.current.set(datasetId, handler);
        const kept = pending.current;
        if (kept && kept.dataset_id === datasetId) {
          pending.current = null;
          handler(kept);
        }
        return () => {
          if (forms.current.get(datasetId) === handler) forms.current.delete(datasetId);
        };
      },
    }),
    [],
  );
  const value = useMemo<AssistantValue>(
    () => ({ ...actions, entries, open, setOpen }),
    [actions, entries, open],
  );
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

/** The assistant, or null outside the logged-in app (e.g. a component test). */
export function useAssistant(): AssistantValue | null {
  return useContext(AssistantContext);
}

/** Calls the latest `fn` through a stable function (registered once). */
function useLatest<T extends (...args: never[]) => unknown>(fn: T) {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: Parameters<T>) => ref.current(...args) as ReturnType<T>, []);
}

/** The explorer of network `runId` receives the assistant's actions for it while mounted. */
export function useAssistantExplorer(runId: number | null, handler: ExplorerHandler) {
  const register = useAssistant()?.registerExplorer;
  const stable = useLatest(handler);
  useEffect(() => register?.(runId, stable), [register, runId, stable]);
}

/** A Build network form receives proposals for its dataset while it is mounted. */
export function useAssistantBuildForm(datasetId: number, handler: ProposalHandler) {
  const register = useAssistant()?.registerBuildForm;
  const stable = useLatest(handler);
  useEffect(() => register?.(datasetId, stable), [register, datasetId, stable]);
}
