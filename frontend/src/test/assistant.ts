// Fixtures for the assistant's tests: a dataset, its network options, a
// proposal, and a way to hold the chat's answer back (to see "Thinking…").
import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

import type { ChatReply, NetworkProposal } from "../api/client";
import type { mockApi } from "./mockApi";

export const DATASET = {
  id: 7,
  name: "AI in medicine",
  created_at: "2026-11-12T10:00:00Z",
  profile_status: "ready",
  profile_error: null,
  files: [{ id: 1, original_name: "WoS_1.xls", size_bytes: 1024, sha256: "x" }],
};

const entity = (key: string, label: string, links: string[], many = true) => ({
  key,
  label,
  many_per_article: many,
  available: true,
  reason: null,
  links,
});
const link = (key: string, label: string, kind: string, models: string[]) => ({
  key,
  label,
  kind,
  models,
  available: true,
  reason: null,
});

export const OPTIONS = {
  entities: [
    entity("institution", "Institution (all authors)", ["keywords", "same_article"]),
    entity("country", "Country", ["keywords", "same_article"]),
    entity("journal", "Journal", ["keywords", "article_title"], false),
  ],
  links: [
    link("same_article", "Same article", "same_article", ["word_matching"]),
    link("keywords", "Keywords", "list", ["word_matching"]),
    link("article_title", "Article title", "string", ["word_overlap", "character_similarity"]),
  ],
  models: [
    { key: "word_matching", label: "Word matching", description: "", threshold_default: null },
    { key: "word_overlap", label: "Word overlap", description: "", threshold_default: 0.5 },
    { key: "character_similarity", label: "Characters", description: "", threshold_default: 0.9 },
  ],
  attributes: [],
  defaults: {
    entity: "institution",
    link: "keywords",
    model: "word_matching",
    min_shared: 3,
    max_item_df: 0.05,
    threshold: 0.5,
    max_word_df: 0.05,
    min_weight: 1,
    top_n: 300,
    max_authors: 15,
    max_team_categories: 12,
    min_team_size: 2,
    node_attributes: [],
  },
};

export const PROPOSAL: NetworkProposal = {
  dataset_id: 7,
  entity: "country",
  link: "keywords",
  model: "word_matching",
  top_n: 150,
  min_weight: 2,
  min_shared: 4,
  max_item_df: 0.1,
  threshold: null,
  max_word_df: null,
  summary: "Country linked by Keywords, word matching, at least 4 shared",
};

export const answer = (reply: string, extra: Partial<ChatReply> = {}): ChatReply => ({
  reply,
  proposal: null,
  actions: [],
  ...extra,
});

/** Holds POST /assistant/chat until release() (other requests answer at once). */
export function holdChat(api: ReturnType<typeof mockApi>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const answerNow = api.fetchMock.getMockImplementation()!;
  api.fetchMock.mockImplementation(async (input, init) => {
    if (String(input).includes("/assistant/chat")) await gate;
    return answerNow(input, init);
  });
  return { release };
}

/** Opens the panel (if needed), types the question and sends it. */
export async function ask(user: UserEvent, question: string) {
  if (!screen.queryByRole("complementary", { name: "Assistant" })) {
    await user.click(await screen.findByRole("button", { name: "Assistant" }));
  }
  const panel = screen.getByRole("complementary", { name: "Assistant" });
  await user.type(within(panel).getByLabelText("Message"), question);
  await user.click(within(panel).getByRole("button", { name: "Send" }));
  return panel;
}
