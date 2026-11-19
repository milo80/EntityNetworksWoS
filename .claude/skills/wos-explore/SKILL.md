---
name: wos-explore
description: Explore a Web of Science export (data/wos/ or uploaded .xls files) to find what it contains and suggest good custom-network settings for EntityNetworks - which entities and link fields the data supports, how dense each combination gets, and which thresholds and minimum link weight keep the network readable. Use it whenever the user asks what can be built from a dataset, why a network is a hairball or empty, which nodes/links/model to pick, wants patterns or insights in their WoS data, or before changing the custom-network defaults in backend/pipeline/custom.py.
---

# Explore a WoS export and suggest network settings

EntityNetworks builds custom networks from three choices: the **nodes**
(an entity), the field that **links** them, and the **model** that compares
that field (`backend/pipeline/custom.py`, explained in "Custom networks" in
`docs/design-notes.md`). What makes a good network depends on the data: how
full each column is, how many values repeat, and how many links a setting
produces. Measure before you recommend; guesses about density are usually
wrong by an order of magnitude.

## Steps

Run from the repository root, in the toolbox (it needs `backend/.venv`).

1. Measure with the bundled script. It is read-only and reuses the pipeline's
   own catalog and code, so its numbers match what the app builds:
   ```bash
   backend/.venv/bin/python .claude/skills/wos-explore/scripts/explore.py data/wos
   ```
   The default checks a quick representative set (about a minute on 3,000
   articles). For one combination add `--entity <key> --link <key> --model <key>`,
   and `--set min_shared=3` (any `CustomParams` field) to try other thresholds.
   `--all` checks every combination (several minutes: Author nodes and
   character similarity on titles are the slow ones). `--json <file>` keeps the
   full results, e.g. in the scratchpad.
2. Read the output in this order:
   - **Columns**: fill %, distinct values, list % (cells with ";"), length.
     Very low fill or one distinct value means the column can't carry a network.
   - **Catalog availability**: which entities and link fields the app will
     offer for this data, and why others are greyed out (under 20% fill).
   - **Combinations**: links in the full graph, then the average degree of the
     exported network (up to `top_n` nodes) at minimum link weights 1, 2, 3, 5
     and 10, and the smallest weight that keeps the average degree at or under
     the target (default 8; `--target-degree`). An average degree above ~15 on
     a few hundred nodes draws as a hairball; under ~1 the network falls apart
     into pairs.
3. Recommend settings, with the measured numbers behind each. Good
   recommendations say what the network shows (e.g. "institutions that publish
   on the same topics"), not just parameter values.
4. If asked to change the defaults, edit `CustomParams` in
   `backend/pipeline/custom.py`, `THRESHOLD_DEFAULTS`, and the matching API
   defaults in `backend/app/schemas/api.py` (a test keeps them in sync), then
   run the `api-change` skill: the defaults appear in the API contract.

## What the numbers mean

- **Weight** of a link = number of matched article pairs behind it. Most
  links in dense combinations have weight 1 (`share_weight_1`), which is why a
  minimum link weight of 2-3 cleans up keyword and category networks.
- **Word matching**: `min_shared` (items two articles must share) and
  `max_item_df` (ignore items in more than this share of articles). Lower
  `max_item_df` removes generic items like "artificial intelligence" in an AI
  corpus.
- **Word overlap / characters**: `threshold` (0-1) and `max_word_df` (only
  values sharing a word rarer than this are compared).
- "Same article" links have no model thresholds; only the minimum link weight
  (papers in common) thins them.

## Patterns worth pointing out

Beyond settings, the measurements often show something about the data itself:
a few journals or organizations holding most articles, funders filled in only
for part of the corpus, countries all linked to each other (a small, complete
graph is a sign the link field is too generic), or title similarity finding
near-duplicate records. Mention these; they help the user read their network.

## Rules

- Read-only: don't write into `data/`, the database or the code unless the
  user asks for a defaults change.
- Report what you measured and how (command, data, settings); don't present
  estimates as measurements.
- The WoS data is licensed: don't copy records or long excerpts into files
  that get committed.
