import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";

import { api, type NetworkOptions, type Relation, type RunCreate } from "../api/client";
import {
  BarList,
  GROUPS,
  groupStyle,
  linkContents,
  linkNote,
  nodeNote,
  readyProfile,
  useProfile,
  type CatalogEntry,
  type LinkEntry,
} from "../components/catalog";
import { ErrorNote } from "../components/common";
import { clearFormState, loadFormState, saveFormState } from "../lib/buildFormState";
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

const FIELDS: Record<FieldName, { label: string; min: number; max: number; help: string }> = {
  topN: {
    label: "Maximum nodes",
    min: 10,
    max: 2000,
    help:
      "Keeps at most this many nodes: the largest connected groups first, then the most " +
      "connected nodes in each. It doesn’t change how links are found, only how much of the " +
      "network is shown. More nodes take longer to lay out and to read.",
  },
  maxAuthors: {
    label: "Ignore papers with more authors than",
    min: 2,
    max: 200,
    help:
      "Papers with more authors are dropped before anything is linked, for every relationship. " +
      "Everyone on a paper (authors, institutions, countries) is linked to everyone else, so " +
      "n authors make n×(n−1)/2 pairs: 15 make 105, 100 make 4,950. In a 3,000-article WoS " +
      "sample, the 3.6% of papers above 15 authors produced 58% of all co-author pairs, so a few " +
      "consortium papers decided which nodes looked most connected. Raise it to include large " +
      "collaborations.",
  },
  minShared: {
    label: "Minimum shared keywords",
    min: 1,
    max: 50,
    help:
      "Two institutions are linked when their articles share at least this many keywords. " +
      "Higher values give fewer, stronger links.",
  },
  maxKeywordPct: {
    label: "Ignore keywords used by more than (%)",
    min: 1,
    max: 100,
    help:
      "Keywords found in more than this share of articles are left out of matching: very " +
      "common keywords don’t indicate a real overlap. Lower is stricter.",
  },
  minItems: {
    label: "Minimum shared items",
    min: 1,
    max: 50,
    help:
      "Two articles match when they share at least this many items of the field. Higher " +
      "values give fewer, stronger links.",
  },
  maxItemPct: {
    label: "Ignore items used by more than (%)",
    min: 1,
    max: 100,
    help:
      "Items found in more than this share of articles are left out of matching (for example " +
      "“artificial intelligence” in an AI dataset): items most articles have don’t indicate a " +
      "real link. Lower is stricter.",
  },
  similarityPct: {
    label: "Minimum similarity (%)",
    min: 5,
    max: 100,
    help: "How alike two texts must be to match. Higher values give fewer, closer matches.",
  },
  maxWordPct: {
    label: "Ignore words used by more than (%)",
    min: 1,
    max: 100,
    help:
      "Only texts that share a word rarer than this are compared, which keeps the run fast and " +
      "skips matches on generic words. Lower is faster and stricter.",
  },
};

const RELATION_HELP: Record<Relation, string> = {
  author: "Authors, linked when they wrote a paper together.",
  institution_keywords: "Institutions, linked when their articles share keywords.",
  custom: "Choose what the nodes are and which article field links them.",
};

const LINKS_HELP: Partial<Record<Relation, string>> = {
  author:
    "Two authors are linked for each paper they wrote together; link weight = papers in common.",
};

type LinkKind = NetworkOptions["links"][number]["kind"];

function fieldsFor(
  relation: Relation | null,
  kind: LinkKind | undefined,
  model: string,
): FieldName[] {
  if (relation === null) return [];
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

const DEFAULT_VALUES: Record<FieldName, string> = {
  topN: DEFAULT_TOP_N.author,
  maxAuthors: "15",
  minShared: "3",
  maxKeywordPct: "12",
  minItems: "3",
  maxItemPct: "5",
  similarityPct: "50",
  maxWordPct: "5",
};
const DEFAULT_CUSTOM = { entity: "institution", link: "keywords", model: "word_matching" };

export function BuildNetworkForm({ datasetId }: { datasetId: number }) {
  const qc = useQueryClient();
  const options = useNetworkOptions(datasetId);
  // Kept per dataset while you look elsewhere (View data, an explorer) and
  // come back; a first visit starts collapsed with no relationship chosen.
  const [saved] = useState(() => loadFormState(datasetId));
  const [relation, setRelation] = useState<Relation | null>(saved?.relation ?? null);
  // The fields keep the text as typed, so a field can be emptied while editing.
  const [values, setValues] = useState<Record<FieldName, string>>({
    ...DEFAULT_VALUES,
    ...(saved?.values as Partial<Record<FieldName, string>> | undefined),
  });
  const [custom, setCustom] = useState(saved?.custom ?? DEFAULT_CUSTOM);
  const [expanded, setExpanded] = useState(saved?.expanded ?? false);
  const [moreOpen, setMoreOpen] = useState(saved?.moreOpen ?? false);
  useEffect(() => {
    saveFormState(datasetId, { relation, values, custom, expanded, moreOpen });
  }, [datasetId, relation, values, custom, expanded, moreOpen]);
  // A field's problem is shown once the user has left it.
  const [touched, setTouched] = useState<Set<FieldName>>(new Set());

  const create = useMutation({
    mutationFn: (body: RunCreate) => api.createRun(body),
    onSuccess: () => {
      // Fold the panel so the new network shows in the list; the settings stay.
      setExpanded(false);
      return qc.invalidateQueries({ queryKey: runsKey(datasetId) });
    },
  });

  const opts = options.data;
  const entity = opts?.entities.find((e) => e.key === custom.entity);
  const link = opts?.links.find((l) => l.key === custom.link);
  const model = opts?.models.find((m) => m.key === custom.model);
  const linksForEntity = opts?.links.filter((l) => entity?.links.includes(l.key)) ?? [];

  // The data page's catalog: the chosen node type's and link field's values
  // beside the form, and its group color on the selects.
  const profile = readyProfile(useProfile(datasetId).data);
  const nodeCatalog = profile?.stats.catalog;
  const nodeEntry = nodeCatalog?.find((e) => e.key === custom.entity);
  const linkEntry = profile?.stats.link_catalog?.find((l) => l.key === custom.link);
  const granularity = (key: string) => nodeCatalog?.find((e) => e.key === key)?.granularity;
  const entityGroups = ENTITY_GROUPS.map(([label, test]) => ({
    label,
    options: (opts?.entities ?? []).filter((o) => test(o, granularity(o.key))),
  })).filter((g) => g.options.length > 0);

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
    setExpanded(true);
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

  const describedBy = (id: string, name?: FieldName) =>
    [`${id}-help`, name && invalid(name) ? "build-network-problems" : null]
      .filter(Boolean)
      .join(" ");

  const inputProps = (name: FieldName, id: string) => ({
    id,
    className: "input input-num",
    type: "number",
    min: FIELDS[name].min,
    max: FIELDS[name].max,
    value: values[name],
    "aria-invalid": invalid(name) || undefined,
    "aria-describedby": describedBy(id, name),
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      setValues((v) => ({ ...v, [name]: e.target.value })),
    onBlur: () => setTouched((t) => new Set(t).add(name)),
  });

  const field = (name: FieldName, id: string) => (
    <ParamRow key={name} id={id} label={FIELDS[name].label} help={FIELDS[name].help}>
      <input {...inputProps(name, id)} />
    </ParamRow>
  );

  const reset = () => {
    clearFormState(datasetId);
    setRelation(null);
    setValues(DEFAULT_VALUES);
    setCustom(DEFAULT_CUSTOM);
    setExpanded(false);
    setMoreOpen(false);
    setTouched(new Set());
    create.reset();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (relation === null) return;
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
  const sameArticle = link?.kind === "same_article";

  const form = (
    <form className="panel-form" onSubmit={onSubmit} aria-label="Build network" noValidate>
      <div className="panel-head">
        <h3 className="panel-title">Create network</h3>
        {relation && (
          <button
            type="button"
            className="icon-btn panel-collapse"
            aria-label={expanded ? "Hide settings" : "Show settings"}
            title={expanded ? "Hide settings" : "Show settings"}
            aria-expanded={expanded}
            onClick={() => setExpanded((x) => !x)}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d={expanded ? "M3.5 10 8 5.5 12.5 10" : "M3.5 6 8 10.5 12.5 6"}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      <ParamRow
        id="relation"
        label="Relationship"
        help={relation ? RELATION_HELP[relation] : "Pick what to build; its settings open below."}
      >
        <select
          id="relation"
          className="select"
          value={relation ?? ""}
          aria-describedby="relation-help"
          onChange={(e) => chooseRelation(e.target.value as Relation)}
        >
          <option value="" disabled>
            Choose a relationship…
          </option>
          <option value="author">{RELATION_LABEL.author}</option>
          <option value="institution_keywords">{RELATION_LABEL.institution_keywords}</option>
          <option value="custom">Custom…</option>
        </select>
        {relation && expanded && (
          <div className="panel-toggles">
            <button type="button" className="btn btn-link" onClick={reset}>
              Reset
            </button>
          </div>
        )}
      </ParamRow>

      {relation && expanded && (
        <>
          <ParamGroup title="Nodes" subtitle="what each dot is">
            {relation === "custom" && opts && (
              <ParamRow
                id="custom-entity"
                label="Nodes"
                help="What each dot in the graph is. All of them that appear on the same article can be linked to each other."
              >
                <select
                  id="custom-entity"
                  className={nodeEntry ? "select select-marked" : "select"}
                  style={groupStyle(nodeEntry?.granularity)}
                  value={custom.entity}
                  aria-describedby="custom-entity-help"
                  onChange={(e) => chooseEntity(e.target.value)}
                >
                  {nodeCatalog
                    ? entityGroups.map((g) => (
                        <optgroup key={g.label} label={g.label}>
                          {g.options.map(entityOption)}
                        </optgroup>
                      ))
                    : opts.entities.map(entityOption)}
                </select>
              </ParamRow>
            )}
            {field("topN", "top-n")}
          </ParamGroup>

          <ParamGroup title="Links" subtitle="when two nodes are connected">
            {LINKS_HELP[relation] && <p className="param-help">{LINKS_HELP[relation]}</p>}
            {relation === "institution_keywords" && (
              <>
                {field("minShared", "min-shared")}
                {field("maxKeywordPct", "max-df")}
              </>
            )}
            {relation === "custom" && opts && (
              <>
                <ParamRow
                  id="custom-link"
                  label="Linked by"
                  help={
                    sameArticle
                      ? "Two nodes are linked each time they appear on the same article; link weight = articles in common."
                      : "The article field compared to decide whether two nodes are connected. Link weight = number of matching article pairs."
                  }
                >
                  <select
                    id="custom-link"
                    className={linkEntry ? "select select-marked" : "select"}
                    style={groupStyle(linkEntry ? "links" : undefined)}
                    value={custom.link}
                    aria-describedby="custom-link-help"
                    onChange={(e) => chooseLink(e.target.value)}
                  >
                    {linksForEntity.map((o) => (
                      <option key={o.key} value={o.key} disabled={!o.available}>
                        {o.available ? o.label : `${o.label} (not in this data)`}
                      </option>
                    ))}
                  </select>
                </ParamRow>
                {!sameArticle && (
                  <ParamRow
                    id="custom-model"
                    label="Model"
                    help={
                      <>
                        How two values of the field are compared. <span>{model?.description}</span>
                      </>
                    }
                  >
                    <select
                      id="custom-model"
                      className="select"
                      value={custom.model}
                      aria-describedby="custom-model-help"
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
                  </ParamRow>
                )}
                {modelFields.map((name) => field(name, `custom-${name}`))}
              </>
            )}
          </ParamGroup>

          <details
            open={moreOpen}
            onToggle={(e) => setMoreOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary>More options</summary>
            <ParamGroup title="Articles" subtitle="filtered before anything is linked">
              {field("maxAuthors", "max-authors")}
            </ParamGroup>
          </details>

          <div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={create.isPending || !canBuild}
            >
              {create.isPending ? "Queuing…" : "Build network"}
            </button>
          </div>
          {problems.length > 0 && (
            <ul id="build-network-problems" className="error field-problems" role="alert">
              {problems.map(([name, problem]) => (
                <li key={name}>{problem}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {create.isError && <ErrorNote error={create.error} />}
    </form>
  );

  // One wrapper always, so the form isn't remounted when the sides appear.
  const sides = relation === "custom" && expanded && !!opts && !!nodeCatalog;
  return (
    <div className="build-layout">
      {sides && <NodeValues entity={entity} entry={nodeEntry} />}
      {form}
      {sides && (
        <LinkValues
          link={link}
          entry={linkEntry}
          nodeEntry={nodeCatalog.find((e) => e.key === linkEntry?.same_as_node)}
        />
      )}
    </div>
  );
}

type EntityOption = NetworkOptions["entities"][number];

const entityOption = (o: EntityOption) => (
  <option key={o.key} value={o.key} disabled={!o.available}>
    {o.available ? o.label : `${o.label} (not in this data)`}
  </option>
);

/** The Nodes select's option groups, named like the data page's catalog groups. */
const ENTITY_GROUPS: [
  string,
  (o: EntityOption, g: CatalogEntry["granularity"] | undefined) => boolean,
][] = [
  [GROUPS.fine.option, (_, g) => g === "fine"],
  [GROUPS.coarse.option, (_, g) => g === "coarse"],
  ["Other", (o, g) => g === undefined && o.available],
  ["Not in this data", (o, g) => g === undefined && !o.available],
];

/** Beside the form: the chosen node type's top values (left). */
function NodeValues({ entity, entry }: { entity?: EntityOption; entry?: CatalogEntry }) {
  return (
    <aside className="catalog-side" aria-label="Node values" style={groupStyle(entry?.granularity)}>
      <SideHead title={entry ? GROUPS[entry.granularity].title : "Nodes"} marked={!!entry} />
      {entry ? (
        <BarList
          level={4}
          idPrefix="side-"
          title={entry.label}
          note={nodeNote(entry)}
          items={entry.top}
        />
      ) : (
        <p className="small muted">
          {entity?.key === "article"
            ? "One node per article."
            : "No values to show for this node type."}
        </p>
      )}
    </aside>
  );
}

/** Beside the form: what the chosen link field contains (right). */
function LinkValues({
  link,
  entry,
  nodeEntry,
}: {
  link?: NetworkOptions["links"][number];
  entry?: LinkEntry;
  nodeEntry?: CatalogEntry;
}) {
  const items = entry?.top?.length ? entry.top : nodeEntry?.top;
  return (
    <aside className="catalog-side" aria-label="Link field values" style={groupStyle("links")}>
      <SideHead title={GROUPS.links.title} marked />
      {entry && items ? (
        <BarList
          level={4}
          idPrefix="side-"
          title={entry.label}
          note={
            nodeEntry ? `${linkNote(entry)} · same values as ${nodeEntry.label}` : linkNote(entry)
          }
          items={items}
        />
      ) : (
        <section>
          <h4>{entry?.label ?? link?.label}</h4>
          <p className="small muted">
            {entry
              ? `${linkContents(entry)} · on ${entry.articles_with_pct}% of articles`
              : "No values to show for this field."}
          </p>
        </section>
      )}
    </aside>
  );
}

function SideHead({ title, marked }: { title: string; marked: boolean }) {
  return (
    <h3 className="catalog-side-head">
      {marked && <span className="catalog-dot" aria-hidden="true" />}
      {title}
    </h3>
  );
}

function ParamGroup({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="param-group">
      <legend>
        {title} <span className="param-group-sub">· {subtitle}</span>
      </legend>
      {children}
    </fieldset>
  );
}

/** One parameter: its name above the control, and what it does to the right. */
function ParamRow({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="param-row">
      <div className="field">
        <label htmlFor={id}>{label}</label>
        {children}
      </div>
      <p id={`${id}-help`} className="param-help">
        {help}
      </p>
    </div>
  );
}
