import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent, type FormEvent } from "react";

import { api, type NetworkOptions, type Relation, type RunCreate } from "../api/client";
import { ErrorNote } from "../components/common";
import { RELATION_LABEL, useNetworkOptions } from "../lib/runLabels";

export const runsKey = (datasetId: number) => ["runs", datasetId] as const;

// Initial values mirror the API defaults, and the limits its validation
// (app/schemas/api.py).
const DEFAULT_TOP_N: Record<Relation, string> = {
  author: "700",
  institution_keywords: "150",
  custom: "300",
};

type FieldName =
  | "topN"
  | "maxAuthors"
  | "minShared"
  | "maxKeywordPct"
  | "minItems"
  | "maxItemPct"
  | "similarityPct"
  | "maxWordPct";

const FIELDS: Record<FieldName, { label: string; min: number; max: number; hint?: string }> = {
  topN: { label: "Maximum nodes", min: 10, max: 2000 },
  maxAuthors: { label: "Ignore papers with more authors than", min: 2, max: 200 },
  minShared: { label: "Minimum shared keywords", min: 1, max: 50 },
  maxKeywordPct: { label: "Ignore keywords used by more than (%)", min: 1, max: 100 },
  minItems: { label: "Minimum shared items", min: 1, max: 50 },
  maxItemPct: {
    label: "Ignore items used by more than (%)",
    min: 1,
    max: 100,
    hint: "Items most articles have don’t indicate a real link.",
  },
  similarityPct: { label: "Minimum similarity (%)", min: 5, max: 100 },
  maxWordPct: {
    label: "Ignore words used by more than (%)",
    min: 1,
    max: 100,
    hint: "Only texts that share a less common word are compared.",
  },
};

type LinkKind = NetworkOptions["links"][number]["kind"];

function fieldsFor(relation: Relation, kind: LinkKind | undefined, model: string): FieldName[] {
  if (relation === "author") return ["topN", "maxAuthors"];
  if (relation === "institution_keywords") {
    return ["topN", "maxAuthors", "minShared", "maxKeywordPct"];
  }
  if (kind === "same_article") return ["topN", "maxAuthors"];
  if (model === "word_matching") {
    return ["topN", "maxAuthors", "minItems", "maxItemPct"];
  }
  return ["topN", "maxAuthors", "similarityPct", "maxWordPct"];
}

/** The problem with a field's text, or null when it is a whole number within its limits. */
function fieldProblem(name: FieldName, text: string): string | null {
  const { label, min, max } = FIELDS[name];
  if (text.trim() === "") return `${label}: enter a value.`;
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) {
    return `${label}: enter a whole number from ${min} to ${max}.`;
  }
  return null;
}

const percent = (share: number) => String(Math.round(share * 100));

export function BuildNetworkForm({ datasetId }: { datasetId: number }) {
  const qc = useQueryClient();
  const options = useNetworkOptions(datasetId);
  const [relation, setRelation] = useState<Relation>("author");
  // The fields keep the text as typed, so a field can be emptied while editing.
  const [values, setValues] = useState<Record<FieldName, string>>({
    topN: DEFAULT_TOP_N.author,
    maxAuthors: "15",
    minShared: "3",
    maxKeywordPct: "12",
    minItems: "3",
    maxItemPct: "5",
    similarityPct: "50",
    maxWordPct: "5",
  });
  const [custom, setCustom] = useState({
    entity: "institution",
    link: "keywords",
    model: "word_matching",
  });
  // A field's problem is shown once the user has left it.
  const [touched, setTouched] = useState<Set<FieldName>>(new Set());

  const create = useMutation({
    mutationFn: (body: RunCreate) => api.createRun(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: runsKey(datasetId) }),
  });

  const opts = options.data;
  const entity = opts?.entities.find((e) => e.key === custom.entity);
  const link = opts?.links.find((l) => l.key === custom.link);
  const model = opts?.models.find((m) => m.key === custom.model);
  const linksForEntity = opts?.links.filter((l) => entity?.links.includes(l.key)) ?? [];

  const active = fieldsFor(relation, link?.kind, custom.model);
  const problems: [string, string][] = active
    .map((name) => [name, fieldProblem(name, values[name])] as const)
    .filter((p): p is readonly [FieldName, string] => p[1] !== null)
    .filter(([name]) => touched.has(name))
    .map(([name, problem]) => [name, problem]);
  const fieldsValid = active.every((name) => fieldProblem(name, values[name]) === null);
  let choiceProblem: string | null = null;
  if (relation === "custom") {
    if (!opts) choiceProblem = "Loading the network options…";
    else if (!entity?.available) choiceProblem = `Nodes: ${entity?.reason ?? "not available"}`;
    else if (!link?.available) choiceProblem = `Linked by: ${link?.reason ?? "not available"}`;
  }
  if (choiceProblem && opts) problems.unshift(["choice", choiceProblem]);
  const invalid = (name: FieldName) => problems.some(([n]) => n === name);
  const canBuild = fieldsValid && !choiceProblem;

  const chooseRelation = (r: Relation) => {
    setRelation(r);
    setValues((v) => {
      const next = { ...v, topN: DEFAULT_TOP_N[r] };
      if (r === "custom" && opts) {
        const d = opts.defaults;
        next.topN = String(d.top_n);
        next.minItems = String(d.min_shared);
        next.maxItemPct = percent(d.max_item_df);
        next.similarityPct = percent(d.threshold);
        next.maxWordPct = percent(d.max_word_df);
      }
      return next;
    });
    if (r === "custom" && opts) {
      const d = opts.defaults;
      setCustom({ entity: d.entity, link: d.link, model: d.model });
    }
  };

  // Keep the three choices compatible: a new entity may need another link
  // field, and a new link field another model (with its default threshold).
  const chooseModel = (key: string) => {
    setCustom((c) => ({ ...c, model: key }));
    const threshold = opts?.models.find((m) => m.key === key)?.threshold_default;
    if (threshold != null) setValues((v) => ({ ...v, similarityPct: percent(threshold) }));
  };
  const chooseLink = (key: string) => {
    const next = opts?.links.find((l) => l.key === key);
    setCustom((c) => ({ ...c, link: key }));
    if (next && !next.models.includes(custom.model as never)) chooseModel(next.models[0]!);
  };
  const chooseEntity = (key: string) => {
    const next = opts?.entities.find((e) => e.key === key);
    setCustom((c) => ({ ...c, entity: key }));
    if (next && !next.links.includes(custom.link as never)) {
      const usable = opts!.links.filter((l) => next.links.includes(l.key));
      const first = usable.find((l) => l.available) ?? usable[0];
      if (first) chooseLink(first.key);
    }
  };

  const inputProps = (name: FieldName) => ({
    className: "input",
    type: "number",
    min: FIELDS[name].min,
    max: FIELDS[name].max,
    value: values[name],
    "aria-invalid": invalid(name) || undefined,
    "aria-describedby": invalid(name) ? "build-network-problems" : undefined,
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      setValues((v) => ({ ...v, [name]: e.target.value })),
    onBlur: () => setTouched((t) => new Set(t).add(name)),
  });

  const field = (name: FieldName, id: string) => (
    <div className="field" key={name}>
      <label htmlFor={id}>{FIELDS[name].label}</label>
      <input id={id} {...inputProps(name)} />
      {FIELDS[name].hint && <span className="hint">{FIELDS[name].hint}</span>}
    </div>
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canBuild) {
      setTouched(new Set(active));
      return;
    }
    const n = (name: FieldName) => Number(values[name]);
    const common = { top_n: n("topN"), max_authors: n("maxAuthors") };
    let body: RunCreate;
    if (relation === "author") {
      body = { dataset_id: datasetId, relation, params: common };
    } else if (relation === "institution_keywords") {
      body = {
        dataset_id: datasetId,
        relation,
        params: {
          ...common,
          min_shared_keywords: n("minShared"),
          max_keyword_df: n("maxKeywordPct") / 100,
        },
      };
    } else {
      body = {
        dataset_id: datasetId,
        relation,
        params: {
          ...common,
          entity: custom.entity as never,
          link: custom.link as never,
          model: custom.model as never,
          min_shared: n("minItems"),
          max_item_df: n("maxItemPct") / 100,
          threshold: n("similarityPct") / 100,
          max_word_df: n("maxWordPct") / 100,
        },
      };
    }
    create.mutate(body);
  };

  const modelFields = active.filter((f) => f !== "topN" && f !== "maxAuthors");

  return (
    <form className="panel-form" onSubmit={onSubmit} aria-label="Build network" noValidate>
      <div className="form-row">
        <div className="field">
          <label htmlFor="relation">Relationship</label>
          <select
            id="relation"
            className="select"
            value={relation}
            onChange={(e) => chooseRelation(e.target.value as Relation)}
          >
            <option value="author">{RELATION_LABEL.author}</option>
            <option value="institution_keywords">{RELATION_LABEL.institution_keywords}</option>
            <option value="custom">Custom…</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="top-n">Maximum nodes</label>
          <input id="top-n" required {...inputProps("topN")} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={create.isPending || !canBuild}>
          {create.isPending ? "Queuing…" : "Build network"}
        </button>
      </div>

      {relation === "custom" && opts && (
        <>
          <div className="form-row custom-choice">
            <div className="field">
              <label htmlFor="custom-entity">Nodes</label>
              <select
                id="custom-entity"
                className="select"
                value={custom.entity}
                onChange={(e) => chooseEntity(e.target.value)}
              >
                {opts.entities.map((o) => (
                  <option key={o.key} value={o.key} disabled={!o.available}>
                    {o.available ? o.label : `${o.label} (not in this data)`}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="custom-link">Linked by</label>
              <select
                id="custom-link"
                className="select"
                value={custom.link}
                onChange={(e) => chooseLink(e.target.value)}
              >
                {linksForEntity.map((o) => (
                  <option key={o.key} value={o.key} disabled={!o.available}>
                    {o.available ? o.label : `${o.label} (not in this data)`}
                  </option>
                ))}
              </select>
            </div>
            {link?.kind !== "same_article" && (
              <div className="field">
                <label htmlFor="custom-model">Model</label>
                <select
                  id="custom-model"
                  className="select"
                  value={custom.model}
                  onChange={(e) => chooseModel(e.target.value)}
                >
                  {opts.models
                    .filter((m) => link?.models.includes(m.key))
                    .map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label}
                      </option>
                    ))}
                </select>
              </div>
            )}
          </div>
          <p className="hint custom-hint">
            {link?.kind === "same_article"
              ? "Links two entities each time they appear on the same article."
              : model?.description}
          </p>
          {modelFields.length > 0 && (
            <div className="form-row form-row-top">
              {modelFields.map((name) => field(name, `custom-${name}`))}
            </div>
          )}
        </>
      )}

      <details>
        <summary>More options</summary>
        <div className="form-row" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="max-authors">Ignore papers with more authors than</label>
            <input id="max-authors" {...inputProps("maxAuthors")} />
            <span className="hint">Large consensus papers otherwise dominate the network.</span>
          </div>
          {relation === "institution_keywords" && (
            <>
              <div className="field">
                <label htmlFor="min-shared">Minimum shared keywords</label>
                <input id="min-shared" {...inputProps("minShared")} />
              </div>
              <div className="field">
                <label htmlFor="max-df">Ignore keywords used by more than (%)</label>
                <input id="max-df" {...inputProps("maxKeywordPct")} />
                <span className="hint">Very common keywords don’t indicate a real overlap.</span>
              </div>
            </>
          )}
        </div>
      </details>
      {problems.length > 0 && (
        <ul id="build-network-problems" className="error field-problems" role="alert">
          {problems.map(([name, problem]) => (
            <li key={name}>{problem}</li>
          ))}
        </ul>
      )}
      {create.isError && <ErrorNote error={create.error} />}
    </form>
  );
}
