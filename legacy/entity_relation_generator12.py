
import pandas as pd
import networkx as nx
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
import numpy as np
from collections import Counter
from itertools import combinations
import glob
import os
import re
import hashlib
import json
from networkx.algorithms.community import greedy_modularity_communities


# Method 2: If you want to read all .xls files in a folder
def combine_excel_files_method2(folder_path='.'):
    # Find all .xls files in the folder
    file_pattern = os.path.join(folder_path, '*.xls')
    file_names = glob.glob(file_pattern)
    
    # Filter to only 3 files (or take first 3)
    file_names = file_names[:3]
    
    dfs = []
    
    for file in file_names:
        try:
            df = pd.read_excel(file, sheet_name='savedrecs')
            dfs.append(df)
            print(f"Successfully read: {os.path.basename(file)} - {len(df)} rows")
        except FileNotFoundError:
            print(f"Warning: {file} not found")
        except Exception as e:
            print(f"Error reading {file}: {e}")
    
    if dfs:
        combined_df = pd.concat(dfs, ignore_index=True)
        print(f"\nCombined dataframe: {len(combined_df)} total rows")
        return combined_df
    else:
        print("No dataframes to combine")
        return pd.DataFrame()


def parse_keyword_columns(df_exploded, columns=('Author Keywords', 'Keywords Plus')):
    """
    Split semicolon-separated keyword fields into clean lists, e.g.
    "AI ethics; Bibliometrics" -> ["AI ethics", "Bibliometrics"].

    These are article-level fields - every co-author on a paper shares the
    exact same keyword list (unlike institution/department, which vary per
    author within the same article). That's why create_author_network()
    treats them differently: instead of picking "the most common one" per
    author (which makes sense for institution), it takes the UNION of every
    keyword across all of that author's articles.

    Adds one '<snake_case_column>' list-column per input column (e.g.
    'author_keywords', 'keywords_plus'). Missing/blank cells become [].
    """
    df_exploded = df_exploded.copy()
    for col in columns:
        if col not in df_exploded.columns:
            continue
        list_col = col.lower().replace(' ', '_')
        df_exploded[list_col] = df_exploded[col].apply(
            lambda v: [kw.strip() for kw in str(v).split(';') if kw.strip()] if pd.notna(v) else []
        )
    return df_exploded



def extract_authors_with_metadata(df):
    """
    Extract authors with metadata including original index and other columns
    Keeps: 'Article Title', 'Source Title', 'UT (Unique WOS ID)'
    """
    # Ensure 'autors_list' exists without re-running the stats report -
    # lets this function be called in isolation (e.g. tests) without
    # requiring the caller to have run prepare_author_lists() first.
    df = prepare_author_lists(df, report=False)

    # Create authors positions
    df['author_level_list'] = df['autors_list'].apply(
        lambda x: list(range(len(x)))
    )
    
    # Count number of authors per row
    df['total_authors'] = df['autors_list'].apply(len)
    
    # Explode - this will keep all columns including Article Title, Source Title, UT (Unique WOS ID)
    df_exploded = df.explode(['autors_list', 'author_level_list'])
    
    # Rename the author columns
    df_exploded = df_exploded.rename(columns={
        'autors_list': 'autors',
        'author_level_list': 'author_level'
    })
    
    # Drop empty rows
    df_exploded = df_exploded[df_exploded['autors'].notna()]
    df_exploded = df_exploded[df_exploded['autors'] != '']
    
    # Select only the columns we want (optional - but keeps them all if you remove this)
    # df_exploded = df_exploded[['Article Title', 'Source Title', 'UT (Unique WOS ID)', 'autors', 'author_level', 'total_authors']]
    
    return df_exploded


def build_orcid_lookup(df_exploded, orcid_column='ORCIDs'):
    """
    Build a name -> ORCID lookup by parsing the ORCIDs column (WoS format:
    "Last, First/0000-0000-0000-0000; ..."), scanned across the whole dataset
    rather than row by row. This matters because an author's ORCID may only
    be listed on some of their papers - once we've seen it once, we can
    apply it wherever else that same name string appears.
    """
    name_to_orcid = {}
    if orcid_column not in df_exploded.columns:
        return name_to_orcid

    for raw in df_exploded[orcid_column].dropna().unique():
        for entry in str(raw).split(';'):
            entry = entry.strip()
            if '/' not in entry:
                continue
            name_part, orcid_part = entry.rsplit('/', 1)
            name_key = name_part.strip().lower()
            orcid_part = orcid_part.strip()
            if name_key and orcid_part:
                name_to_orcid[name_key] = orcid_part

    return name_to_orcid


def synthetic_author_code(name):
    """
    A stable, deterministic stand-in ID for authors with no resolvable ORCID -
    a short hash of their normalized name, prefixed 'LOCAL-' so it's never
    mistaken for a real, externally-verifiable ORCID. Deterministic means the
    same author gets the same code every time the pipeline re-runs, even
    across different samples/exports.
    """
    digest = hashlib.sha1(str(name).strip().lower().encode('utf-8')).hexdigest()[:12]
    return f"LOCAL-{digest}"


def resolve_author_ids(df_exploded, orcid_column='ORCIDs'):
    """
    Adds two columns:
      - 'display_name': the author's name as printed (for showing to people)
      - 'author_id': always a code, never a raw name - the author's ORCID when
        one can be resolved by name, otherwise a stable synthetic code (see
        synthetic_author_code()). Homogenizing this way means every node's id
        looks the same regardless of ORCID coverage; nothing about how the
        graph displays depends on it, since labels/panels all read from
        'display_name' instead.

    This is what create_author_network() should key nodes on - it means the
    same researcher isn't split into two separate nodes just because their
    name was typed slightly differently across papers, wherever an ORCID
    lets us tell that it's the same person.
    """
    name_to_orcid = build_orcid_lookup(df_exploded, orcid_column)

    def resolve(name):
        orcid = name_to_orcid.get(str(name).strip().lower())
        return orcid if orcid else synthetic_author_code(name)

    df_exploded = df_exploded.copy()
    df_exploded['display_name'] = df_exploded['autors']
    df_exploded['author_id'] = df_exploded['autors'].apply(resolve)

    resolved = df_exploded['author_id'].isin(name_to_orcid.values()).sum()
    total = len(df_exploded)
    unique_ids = df_exploded['author_id'].nunique()
    unique_names = df_exploded['autors'].nunique()
    print(f"ORCID resolution: {resolved}/{total} author-article rows resolved to an ORCID ({resolved/total:.0%})")
    print(f"   Unique identities: {unique_ids} (vs. {unique_names} unique raw name strings)")

    return df_exploded


def find_author_id(G, display_name):
    """
    Look up a node's author_id (ORCID or name, whichever the graph is keyed
    on) from a human-readable display name. Needed because you can no longer
    assume the node key IS the name once ORCID resolution is in play.
    """
    target = display_name.strip().lower()
    matches = [n for n, d in G.nodes(data=True) if d.get('display_name', '').strip().lower() == target]
    return matches[0] if matches else None


def prepare_author_lists(df, column_name='Author Full Names', report=True):
    """
    Ensure the article-level 'autors_list' column exists - split from the
    raw 'Author Full Names' cell into a list of author name strings, e.g.
    "Smith, J; Doe, A" -> ["Smith, J", "Doe, A"].

    Idempotent: if 'autors_list' is already present (e.g. this df already
    passed through here once upstream), the column is left as-is and not
    recomputed - this is what lets extract_authors_with_metadata(),
    filter_out_mega_papers(), and prepare_article_institution_data() each
    call this directly as a "make sure the column's there" guard, without
    caring whether some earlier step already built it.

    report=True (the default, used once in main() on the full corpus) also
    prints the general article-level statistics block: authors-per-article
    distribution, percentiles, and mega-paper counts - used to help pick a
    sensible max_authors threshold for filter_out_mega_papers(). Pass
    report=False for the "just ensure the column" call sites, so the report
    doesn't get silently re-printed (possibly on a filtered subset) every
    time one of those functions runs.
    """
    df = df.copy()
    if 'autors_list' not in df.columns:
        df['autors_list'] = df[column_name].str.split(';').apply(
            lambda x: [name.strip() for name in x] if isinstance(x, list) else []
        )
    counts = df['autors_list'].apply(len)

    if report:
        print("=" * 60)
        print("📊 GENERAL STATISTICS")
        print("=" * 60)
        print(f"\n📌 Total articles: {len(df)}")

        print("\n📌 Authors-per-article distribution:")
        print(counts.describe())
        print("\n   95th / 99th percentile:", counts.quantile(0.95), '/', counts.quantile(0.99))
        print("   Articles with 15+ authors:", (counts >= 15).sum())
        print("   Articles with 20+ authors:", (counts >= 20).sum())
        print("\n" + "=" * 60)
    return df


def filter_out_mega_papers(df, max_authors=15):
    """
    Drop articles with more than max_authors co-authors before building any
    graph. Large multi-author consensus/guideline papers create near-complete
    cliques that dominate degree rankings and don't reflect real bilateral
    collaboration.

    Operates on the raw, article-level df (one row per article) - counting
    authors straight off the 'autors_list' column rather than requiring the
    author-network explode to have already happened. This makes the filter
    usable as a gate for every relation (author, institution, country, ...),
    not just the author network.
    """
    df = prepare_author_lists(df, report=False)
    before_count = len(df)

    filtered = df[df['autors_list'].apply(len) <= max_authors].copy()

    after_count = len(filtered)

    print(f"\nFiltered out mega-papers (> {max_authors} authors):")
    print(f"   Articles: {before_count} -> {after_count}")

    return filtered




def create_author_network(df_exploded, id_column='author_id', name_column='display_name',
                           extra_attributes=('institution', 'institution_department', 'department', 'city', 'country'),
                           list_attributes=('author_keywords', 'keywords_plus')):
    """
    Create a NetworkX graph from the exploded author data.

    Nodes are keyed by id_column - the author's ORCID when resolve_author_ids()
    found one, otherwise their raw name string. Each node keeps its most
    commonly observed display name and whether it has a real ORCID, as
    attributes, since the node key itself isn't always human-readable.

    extra_attributes: scalar columns (e.g. 'institution', 'country') attached
    per node using the author's most commonly observed value - appropriate
    when one representative value makes sense.

    list_attributes: columns that hold a LIST per row (e.g. 'author_keywords'
    from parse_keyword_columns()) attached per node as the UNION of every
    value seen across all of that author's articles, deduplicated and sorted.
    "Most common single value" doesn't make sense for something inherently
    multi-valued like keywords - an author who writes about both "AI ethics"
    and "bibliometrics" doesn't have one truer topic than the other.

    Both silently skip columns that aren't present in df_exploded (e.g. if
    enrich_with_institution_data() / parse_keyword_columns() weren't run).

    Each edge (a co-authorship) carries:
      - 'weight': number of articles the pair co-authored
      - 'articles': one record per shared article - {id, title, level_a,
        level_b} - the author-position detail used e.g. to distinguish a
        first-author/senior-author pairing from two mid-list co-authors.
      - 'article_titles': the flat, sorted, deduplicated titles pulled out
        of 'articles' above. This is the pre-aggregated form
        export_graph_to_json()'s edge_attrs can pick up directly (it does
        no aggregation of its own) - 'articles' itself is a list of dicts
        and isn't usable as a flat attribute for the frontend's
        attribute-search panel, same reasoning as 'shared_keywords' on the
        institution-keyword network's edges.

    Parameters:
    df_exploded: DataFrame with columns [id_column, name_column, 'author_level',
                 'UT (Unique WOS ID)', 'Article Title']

    Returns:
    NetworkX Graph
    """
    G = nx.Graph()

    # Falls back to the raw name if resolve_author_ids() was never run
    if id_column not in df_exploded.columns:
        id_column = 'autors'
    if name_column not in df_exploded.columns:
        name_column = 'autors'

    available_extra = [c for c in extra_attributes if c in df_exploded.columns]
    available_list = [c for c in list_attributes if c in df_exploded.columns]

    # Add nodes, picking the most common observed value per author_id for
    # display name and each scalar attribute, and the union for list attributes
    name_counts = {}
    extra_counts = {c: {} for c in available_extra}
    list_values = {c: {} for c in available_list}  # {author_id: {lowercase_kw: original-case kw}} - case-insensitive dedup
    for _, row in df_exploded.iterrows():
        author_id = row[id_column]
        name_counts.setdefault(author_id, Counter())[row[name_column]] += 1
        for c in available_extra:
            val = row[c]
            if pd.notna(val):
                extra_counts[c].setdefault(author_id, Counter())[val] += 1
        for c in available_list:
            vals = row[c]
            if isinstance(vals, list) and vals:
                bucket = list_values[c].setdefault(author_id, {})
                for v in vals:
                    key = v.strip().lower()
                    if key and key not in bucket:
                        bucket[key] = v.strip()

    orcid_pattern = re.compile(r'^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$')
    for author_id, counts in name_counts.items():
        display_name = counts.most_common(1)[0][0]
        node_attrs = {'display_name': display_name, 'has_orcid': bool(orcid_pattern.match(str(author_id)))}
        for c in available_extra:
            author_counts = extra_counts[c].get(author_id)
            node_attrs[c] = author_counts.most_common(1)[0][0] if author_counts else None
        for c in available_list:
            node_attrs[c] = sorted(list_values[c].get(author_id, {}).values(), key=str.lower)
        G.add_node(author_id, **node_attrs)

    # Add edges (co-authorship through articles)
    for article_id, group in df_exploded.groupby('UT (Unique WOS ID)'):
        authors_sorted = group.sort_values('author_level')
        authors_list = authors_sorted[id_column].tolist()
        article_title = group['Article Title'].iloc[0]
        
        # Add edges between all pairs of authors in this article
        for i in range(len(authors_list)):
            for j in range(i + 1, len(authors_list)):
                author_a = authors_list[i]
                author_b = authors_list[j]
                level_a = authors_sorted.iloc[i]['author_level']
                level_b = authors_sorted.iloc[j]['author_level']
                
                # Add edge with attributes
                if G.has_edge(author_a, author_b):
                    # Increment weight if edge exists
                    G[author_a][author_b]['weight'] += 1
                    G[author_a][author_b]['articles'].append({
                        'id': article_id,
                        'title': article_title,
                        'level_a': level_a,
                        'level_b': level_b
                    })
                else:
                    G.add_edge(author_a, author_b, 
                              weight=1,
                              articles=[{
                                  'id': article_id,
                                  'title': article_title,
                                  'level_a': level_a,
                                  'level_b': level_b
                              }])

    # Flat, edge-level union of every article title behind this
    # collaboration - see the 'article_titles' note in the docstring above.
    # Done as a pass over the finished edges rather than incrementally
    # during the loop above, since 'articles' (built incrementally either
    # way) is already the source of truth - simpler to derive from it once
    # than to keep two structures in sync across both the "new edge" and
    # "existing edge" branches.
    for _, _, edata in G.edges(data=True):
        edata['article_titles'] = sorted({a['title'] for a in edata['articles'] if a.get('title')})

    return G



def normalize_country(raw_country):
    """
    WoS bundles US state + zip into the same trailing segment as the country
    (e.g. "TX 77807 USA" instead of a separate "USA" field), so without this,
    nearly every US address would come out as a distinct 'country' value.
    Everything else is passed through unchanged.
    """
    if not raw_country:
        return raw_country
    if re.search(r'\bUSA\b', raw_country, re.IGNORECASE):
        return 'USA'
    return raw_country.strip()


def parse_address_block(address_str):
    """
    Parse one WoS 'Addresses' cell into a list of author-level records.

    WoS format bundles each address with the specific authors it belongs to:
      "[Author A; Author B] Institution, Dept X, City, Country; [Author C] Institution2, City2, Country2"

    Each bracketed group is only split from the next at "; [" - commas inside
    a single address block (institution, department, city, country) are safe
    to split on, since author names inside the brackets never contain ", [".

    Returns a list of dicts: {'author_name', 'institution', 'department', 'city', 'country'}
    Department is only populated when a comma-separated segment starts with
    "Dept" (the standard WoS abbreviation) - not every address includes one.
    """
    if not isinstance(address_str, str) or not address_str.strip():
        return []

    records = []
    chunks = re.split(r';\s*(?=\[)', address_str)
    for chunk in chunks:
        m = re.match(r'^\[([^\]]+)\]\s*(.+)$', chunk.strip())
        if not m:
            continue
        authors = [a.strip() for a in m.group(1).split(';')]
        parts = [p.strip() for p in m.group(2).split(',') if p.strip()]
        if not parts:
            continue

        institution = parts[0]
        department = next((p for p in parts[1:] if p.lower().startswith('dept')), None)
        country = normalize_country(parts[-1]) if len(parts) >= 1 else None
        city = parts[-2] if len(parts) >= 2 else None

        for author in authors:
            records.append({
                'author_name': author,
                'institution': institution,
                'department': department,
                'city': city,
                'country': country
            })
    return records


def enrich_with_institution_data(df_exploded, address_column='Addresses'):
    """
    Attach institution / department / city / country to each author-article
    row by parsing the WoS 'Addresses' field, matched by author name within
    the same article (the same person can have a different affiliation on
    different papers, so this is resolved per-article, not globally).

    Also adds 'institution_department', a compound key combining institution
    and department - plain department names repeat across institutions
    (e.g. many hospitals have a "Dept Cardiol"), so department alone isn't a
    safe grouping key on its own.

    Known limitation: for North American / UK-style addresses that include a
    state or province ("Bryan, TX 77807 USA", "..., ON, Canada"), the city
    field can end up holding the state/province abbreviation instead of the
    actual city. Institution and country are unaffected by this.
    """
    # IMPORTANT: df_exploded's index has duplicates (every author-row from the
    # same article keeps that article's original row index, since it comes
    # from .explode()). Assigning with .loc[idx, col] on a duplicate index
    # overwrites every row sharing that label, not just one - so this must
    # run on a uniquely-indexed copy, or every author in a multi-institution
    # paper silently ends up with whichever author was processed last.
    df_exploded = df_exploded.reset_index(drop=True)

    for col in ['institution', 'department', 'city', 'country']:
        df_exploded[col] = None

    for article_id, group in df_exploded.groupby('UT (Unique WOS ID)'):
        address_str = group[address_column].iloc[0]
        records = parse_address_block(address_str)
        name_lookup = {r['author_name'].strip().lower(): r for r in records}

        for idx, row in group.iterrows():
            match = name_lookup.get(str(row['autors']).strip().lower())
            if match:
                df_exploded.loc[idx, 'institution'] = match['institution']
                df_exploded.loc[idx, 'department'] = match['department']
                df_exploded.loc[idx, 'city'] = match['city']
                df_exploded.loc[idx, 'country'] = match['country']

    df_exploded['institution_department'] = df_exploded.apply(
        lambda r: f"{r['institution']} \u2014 {r['department']}" if pd.notna(r['department']) else r['institution'],
        axis=1
    )

    matched = df_exploded['institution'].notna().sum()
    total = len(df_exploded)
    print(f"Matched institution for {matched}/{total} author-article rows ({matched/total:.0%})")
    print(f"   Unique institutions: {df_exploded['institution'].nunique()}")
    print(f"   Unique institution+department pairs: {df_exploded['institution_department'].nunique()}")
    print(f"   Unique countries: {df_exploded['country'].nunique()}")

    return df_exploded


def parse_reprint_address_block(reprint_str):
    """
    Parse one WoS 'Reprint Addresses' cell into a list of institution
    records for the corresponding author(s) - the counterpart to
    parse_address_block() for the 'Addresses' field, but a different raw
    format (no bracket notation):

      "Last, FI (corresponding author), Institution, Dept X, City, Country.;
       Last, FI (corresponding author), Institution2, City2, Country2."

    Entries are separated by ';' and each ends in '.'. A single
    corresponding author can still list more than one institution (their
    entry simply repeats, once per institution) - this function returns
    every record found, in the order listed; picking one is
    pick_anchor_institution()'s job, not this function's.

    Returns a list of dicts: {'author_name', 'institution', 'department',
    'city', 'country'} - same shape as parse_address_block()'s records.
    """
    if not isinstance(reprint_str, str) or not reprint_str.strip():
        return []

    records = []
    entries = re.split(r';\s*', reprint_str.strip())
    for entry in entries:
        entry = entry.strip().rstrip('.').strip()
        if '(corresponding author)' not in entry:
            continue
        name_part, addr_part = entry.split('(corresponding author)', 1)
        author_name = name_part.strip().rstrip(',')
        parts = [p.strip() for p in addr_part.lstrip(', ').split(',') if p.strip()]
        if not parts:
            continue

        institution = parts[0]
        department = next((p for p in parts[1:] if p.lower().startswith('dept')), None)
        country = normalize_country(parts[-1]) if parts else None
        city = parts[-2] if len(parts) >= 2 else None

        records.append({
            'author_name': author_name,
            'institution': institution,
            'department': department,
            'city': city,
            'country': country
        })
    return records


def is_university(institution_name):
    """
    Heuristic check for whether an institution name looks like a university -
    used by pick_anchor_institution() to prefer university affiliations when
    a corresponding author lists more than one institution. Matches WoS's
    consistent 'Univ' abbreviation as well as spelled-out variants
    ('University', 'Universidad', 'Universitat', 'Universidade', ...) via a
    simple substring check. Known limitation: misses universities whose name
    doesn't contain this string at all (e.g. 'Ecole Polytechnique', 'MIT') -
    an acceptable gap for a tie-break rule, not something to solve here.
    """
    return bool(institution_name) and 'univ' in institution_name.lower()


def pick_anchor_institution(records):
    """
    Given the list of parsed institution records for one article's
    corresponding author(s) (from parse_reprint_address_block() - may have
    more than one entry when the corresponding author lists multiple
    affiliations, or rarely when there's more than one corresponding
    author), pick a single institution to anchor the article to.

    Rule: iterate the records in the order they were listed and return the
    first one that looks like a university (is_university()); if none do,
    fall back to the first-listed record overall. Returns None if there are
    no records at all (e.g. missing/unparseable Reprint Addresses).
    """
    if not records:
        return None
    for r in records:
        if is_university(r['institution']):
            return r
    return records[0]


def prepare_article_institution_data(df, address_column='Reprint Addresses',
                                      doc_types=('Article', 'Review'),
                                      attr_columns=('Article Title', 'Source Title', 'Publication Year')):
    """
    Step 1 (data collection) for the institution/department keyword-based
    collaboration relation - build the article-level dataframe everything
    downstream (keyword normalization/matching, edge building) will run on.
    Matching and edge-building are deliberately NOT done here.

    One row per article - unlike the author network, this relation doesn't
    need an author-level explode. For each article:

      - autors_list: parsed from 'Author Full Names', kept for context/attr
        display only. NOT used to pick the institution - anchoring is on
        the corresponding/reprint author instead of author position.
      - institution / department / city / country / institution_department:
        the corresponding author's affiliation, parsed from Reprint
        Addresses via parse_reprint_address_block() and disambiguated via
        pick_anchor_institution() (prefer a university; else first-listed).
      - author_keywords / keywords_plus: parsed via the existing
        parse_keyword_columns() - it already works at article level, no
        explode required.
      - attr_columns: passed through unchanged for display/filtering,
        mirroring 'attr' in the author network.

    Filters to doc_types (default Article + Review) before anything else,
    since Proceedings Papers / Editorial Material aren't the target of this
    relation.
    """
    before = len(df)
    df = df[df['Document Type'].isin(doc_types)].copy()
    print(f"Filtered to {doc_types}: {before} -> {len(df)} articles")

    # Author list - context/attr only, not used for institution anchoring.
    # Ensured (not recreated if already present) rather than built inline,
    # since upstream callers (e.g. main()) typically already ran
    # prepare_author_lists() on this df before it reaches here.
    df = prepare_author_lists(df, report=False)

    # Corresponding-author institution, with the university-preference tie-break
    anchors = df[address_column].apply(parse_reprint_address_block).apply(pick_anchor_institution)
    df['institution'] = anchors.apply(lambda r: r['institution'] if r else None)
    df['department'] = anchors.apply(lambda r: r['department'] if r else None)
    df['city'] = anchors.apply(lambda r: r['city'] if r else None)
    df['country'] = anchors.apply(lambda r: r['country'] if r else None)
    df['institution_department'] = df.apply(
        lambda r: f"{r['institution']} \u2014 {r['department']}" if pd.notna(r['department']) else r['institution'],
        axis=1
    )

    resolved = df['institution'].notna().sum()
    print(f"Resolved corresponding-author institution for {resolved}/{len(df)} articles ({resolved/len(df):.0%})")
    print(f"   Unique institutions: {df['institution'].nunique()}")
    print(f"   Unique institution+department pairs: {df['institution_department'].nunique()}")
    print(f"   Unique countries: {df['country'].nunique()}")

    # Author Keywords / Keywords Plus -> clean list columns (article-level, no explode needed)
    df = parse_keyword_columns(df, columns=('Author Keywords', 'Keywords Plus'))

    keep_cols = ['UT (Unique WOS ID)', 'autors_list', 'author_keywords', 'keywords_plus',
                 'institution', 'department', 'city', 'country', 'institution_department'] + list(attr_columns)
    return df[keep_cols]


def normalize_keyword(kw):
    """
    Lowercase and fold hyphens to spaces, so 'ARTIFICIAL-INTELLIGENCE'
    (the typical Keywords Plus style) and 'artificial intelligence' (the
    typical Author Keywords style) are recognized as the same term. This is
    the "a" (normalized exact match) half of the matching strategy - it's
    what decides whether two keyword strings count as the same keyword at
    all, before rarity-weighting decides whether that keyword is eligible
    to drive a match.
    """
    return str(kw).strip().lower().replace('-', ' ')


def build_article_keyword_profiles(df, keyword_columns=('author_keywords', 'keywords_plus')):
    """
    Add a 'keywords_norm' column: the sorted, deduplicated union of
    normalized keywords per article, pooled across keyword_columns (the
    list-columns parse_keyword_columns() already produces). Article-level,
    no explode needed.
    """
    df = df.copy()

    def union_normalized(row):
        kws = set()
        for col in keyword_columns:
            for kw in (row.get(col) or []):
                norm = normalize_keyword(kw)
                if norm:
                    kws.add(norm)
        return sorted(kws)

    df['keywords_norm'] = df.apply(union_normalized, axis=1)
    return df


def compute_keyword_document_frequency(df, keyword_column='keywords_norm'):
    """
    Document frequency per normalized keyword across the given article set -
    how many articles mention it at least once. Feeds both the rarity
    weighting and the "too generic to be meaningful" exclusion in
    create_institution_keyword_network() - the keyword-level analogue of
    filter_out_mega_papers() excluding mega-papers from the author network,
    just applied to terms instead of articles.
    """
    doc_freq = Counter()
    for kws in df[keyword_column]:
        doc_freq.update(set(kws))
    return doc_freq


def create_institution_keyword_network(df, group_column='institution_department',
                                        node_attributes=('institution', 'department', 'city', 'country'),
                                        max_keyword_df=0.2, min_shared_keywords=1):
    """
    Build the institution potential-collaboration network: an edge between
    two institutions (or institution-departments / countries, depending on
    group_column) means at least one pair of their articles shares
    specific, non-generic keyword(s) - a proxy for related research themes,
    as distinct from the author network's edges (actual co-authorship).

    Matching strategy (v1) = normalized exact match (build_article_keyword_profiles,
    via normalize_keyword) + rarity-weighting: any keyword appearing in more
    than max_keyword_df of the article pool (default 20%) is excluded from
    matching entirely, on both sides of a comparison. This matters in
    practice - in early testing on a sample AI-in-medicine corpus,
    "artificial intelligence" alone appeared in 72% of articles, which
    would otherwise connect nearly every institution pair for a reason that
    carries no real signal: nearly everyone in that corpus works on AI, so
    sharing that one term doesn't indicate a distinctive overlap the way
    sharing something like "fetal ultrasound" or "bibliometric analysis"
    does. Excluded keywords are still visible on each article's own
    keyword list - they just can't be the basis for an edge.

    node_attributes: scalar columns attached per node using the
    most-commonly-observed value for that group_column value - same
    aggregation create_author_network() uses for its scalar attributes.
    This is what lets export_graph_to_json()'s team_attribute (e.g.
    'country') group/color these nodes by a real attribute instead of
    algorithmic community detection, exactly like the author network
    already supports. Silently skips any column not present in df.

    Edge weight = number of DISTINCT matched article pairs between the two
    institutions (deduplicated - an article pair sharing several eligible
    keywords still counts once, same "collaboration potential" idea you
    described). Each edge also carries:
      - 'articles': one record per matched article pair, listing exactly
        which keyword(s) drove it - the same pattern create_author_network()
        uses for its co-authorship edges.
      - 'shared_keywords': the flat, sorted union of every keyword across
        all of that edge's matched article pairs. This is the pre-aggregated
        form export_graph_to_json()'s edge_attrs can pick up directly (it
        does no aggregation of its own - see that function's docstring) -
        unlike 'articles', which is a list of dicts and isn't usable as a
        flat attribute for the frontend's attribute-search panel.

    Articles with no resolved institution (group_column is null) or no
    normalized keywords are dropped before matching - they can't
    participate either way.

    Returns a NetworkX Graph - same shape as create_grouped_network()'s
    output, so it plugs directly into the existing export_graph_to_json().
    """
    df = build_article_keyword_profiles(df)
    df = df[df[group_column].notna() & (df['keywords_norm'].apply(len) > 0)].copy()

    total_articles = len(df)
    doc_freq = compute_keyword_document_frequency(df)

    eligible_keywords = {
        kw for kw, freq in doc_freq.items()
        if total_articles == 0 or (freq / total_articles) <= max_keyword_df
    }
    excluded_keywords = sorted(set(doc_freq) - eligible_keywords)

    print(f"Keyword matching pool: {total_articles} articles, {len(doc_freq)} unique normalized keywords")
    print(f"   Excluded (appear in >{max_keyword_df:.0%} of articles, too generic to signal a real match): {excluded_keywords}")
    print(f"   {len(eligible_keywords)} keyword(s) eligible for matching")

    # Inverted index: eligible keyword -> article row-indices that carry it.
    # Mirrors the groupby-and-connect pattern used elsewhere (e.g.
    # create_grouped_network grouping by article to connect entities) -
    # here the group is a keyword, and what gets connected are the articles
    # (and, one level up, their institutions) that share it.
    keyword_to_articles = {}
    for idx, row in df.iterrows():
        for kw in row['keywords_norm']:
            if kw in eligible_keywords:
                keyword_to_articles.setdefault(kw, []).append(idx)

    # institution_pair -> {article_pair: {shared keywords}}
    matched_pairs = {}
    for kw, idxs in keyword_to_articles.items():
        for i, j in combinations(idxs, 2):
            row_i, row_j = df.loc[i], df.loc[j]
            inst_i, inst_j = row_i[group_column], row_j[group_column]
            if inst_i == inst_j:
                continue  # only inter-institution matches count here
            ut_i, ut_j = row_i['UT (Unique WOS ID)'], row_j['UT (Unique WOS ID)']
            article_pair = tuple(sorted((ut_i, ut_j)))
            inst_pair = tuple(sorted((inst_i, inst_j)))
            matched_pairs.setdefault(inst_pair, {}).setdefault(article_pair, set()).add(kw)

    # Node attributes: most-commonly-observed value per group_column value,
    # so team_attribute-based grouping/coloring has something real to read.
    available_attrs = [c for c in node_attributes if c in df.columns]
    attr_counts = {c: {} for c in available_attrs}
    for _, row in df.iterrows():
        key = row[group_column]
        for c in available_attrs:
            val = row[c]
            if pd.notna(val):
                attr_counts[c].setdefault(key, Counter())[val] += 1

    G = nx.Graph()
    for key in df[group_column].unique():
        node_attrs = {}
        for c in available_attrs:
            counts = attr_counts[c].get(key)
            node_attrs[c] = counts.most_common(1)[0][0] if counts else None
        G.add_node(key, **node_attrs)

    for (inst_a, inst_b), article_pairs in matched_pairs.items():
        qualifying = {ap: kws for ap, kws in article_pairs.items() if len(kws) >= min_shared_keywords}
        if not qualifying:
            continue
        articles_detail = [
            {'article_a': ap[0], 'article_b': ap[1], 'shared_keywords': sorted(kws)}
            for ap, kws in qualifying.items()
        ]
        # Flat, edge-level union of every keyword that contributed to this
        # institution pair - the pre-aggregated field export_graph_to_json()
        # can expose via edge_attrs=('shared_keywords',).
        shared_keywords = sorted(set().union(*qualifying.values()))
        G.add_edge(inst_a, inst_b, weight=len(qualifying), articles=articles_detail,
                   shared_keywords=shared_keywords)

    matched_institutions = {n for e in G.edges() for n in e}
    print(f"Institution nodes: {G.number_of_nodes()} total, {len(matched_institutions)} with at least one match")
    print(f"Institution-pair edges: {G.number_of_edges()}")

    return G


def create_grouped_network(df_exploded, group_column):
    """
    Build a co-occurrence network at a chosen granularity instead of
    individual authors - e.g. group_column='institution' links two
    institutions whenever different authors from each appear on the same
    paper; group_column='country' does the same at country level.

    """
    df = df_exploded.dropna(subset=[group_column])
    G = nx.Graph()
    G.add_nodes_from(df[group_column].unique())

    for article_id, group in df.groupby('UT (Unique WOS ID)'):
        entities = group[group_column].unique().tolist()
        article_title = group['Article Title'].iloc[0]

        for i in range(len(entities)):
            for j in range(i + 1, len(entities)):
                a, b = entities[i], entities[j]
                if G.has_edge(a, b):
                    G[a][b]['weight'] += 1
                    G[a][b]['articles'].append(article_id)
                else:
                    G.add_edge(a, b, weight=1, articles=[article_id])

    return G


def analyze_grouped_network(G, label='groups'):
    """
    Quick summary for an institution- or country-level network, mirroring
    analyze_network_simplified() but without assuming the nodes are people.
    """
    print("=" * 60)
    print(f"📊 {label.upper()} NETWORK SUMMARY")
    print("=" * 60)
    print(f"\n📌 Total {label}: {G.number_of_nodes()}")
    print(f"📌 Total connections: {G.number_of_edges()}")

    if G.number_of_edges() > 0:
        print(f"\n📌 Top 5 Most Connected {label}:")
        top = sorted(G.degree(), key=lambda x: x[1], reverse=True)[:5]
        for i, (name, degree) in enumerate(top, 1):
            print(f"   {i}. {name}: {degree} connections")

        print(f"\n📌 Top 5 Strongest Links:")
        edge_weights = [(u, v, d['weight']) for u, v, d in G.edges(data=True)]
        top_edges = sorted(edge_weights, key=lambda x: x[2], reverse=True)[:5]
        for i, (u, v, w) in enumerate(top_edges, 1):
            print(f"   {i}. {u} & {v}: {w} shared papers")
    print("\n" + "=" * 60)


def build_connected_sample(G, target_size=40, min_component_size=3):
    """
    Build a well-connected sample instead of picking the top_n nodes by global
    degree and inducing a subgraph on them. Picking by raw degree can leave you
    with mostly-isolated nodes if the highest-degree authors don't happen to
    co-author with each other (this is exactly what happens once mega-papers
    are filtered out - the remaining hub authors are spread across many
    separate small papers).

    Instead, this pulls nodes from the largest connected component(s) first,
    so the sample keeps real edges between the authors shown. Within each
    component, it still prioritizes the most-connected authors.
    """
    components = [c for c in nx.connected_components(G) if len(c) >= min_component_size]
    components.sort(key=len, reverse=True)

    selected_nodes = []
    for component in components:
        if len(selected_nodes) >= target_size:
            break
        remaining = target_size - len(selected_nodes)
        component_subgraph = G.subgraph(component)
        ranked = [a for a, _ in sorted(component_subgraph.degree(), key=lambda x: x[1], reverse=True)]
        selected_nodes.extend(ranked[:remaining])

    return G.subgraph(selected_nodes).copy()


def export_graph_to_json(G, filename, top_n=None, edge_type='related_to',
                          role_suffix='connections', min_community_size=2,
                          max_communities=10, team_attribute=None,
                          max_team_categories=10, min_team_size=2,
                          node_attrs=None, edge_attrs=None):
    """
    Export any graph (author, institution/department, country, ...) as
    web-ready JSON matching the frontend's schema: nodes carry id/name/team/role,
    edges carry source/target/type/weight.

    - top_n: if set and G has more nodes than this, samples from the largest
      connected component(s) (via build_connected_sample) instead of exporting
      everything. Leave as None to export the whole graph as-is - reasonable
      for smaller graphs like institution or country networks.
    - team_attribute: if given (e.g. 'country', 'institution'), "team" comes
      directly from that node attribute instead of algorithmic community
      detection - a category a reader can look up and verify, rather than an
      opaque "cluster_3". The long tail of rare values collapses into "other"
      (max_team_categories / min_team_size) so the legend stays readable, and
      nodes with no value for that attribute get "unknown" - kept distinct
      from "other" so missing data doesn't masquerade as a real small group.
      Leave as None to fall back to community detection (the original
      behavior - still what institution/country exports use).
    - node_attrs: optional list of node-attribute names (e.g. ['institution',
      'department', 'city']) to include under a nested "attr" dict on each
      node. These are display/search-only on the frontend - they don't drive
      coloring or the Group/Relationship filters, only the raw JSON view and
      (once wired up) the attribute-search panel. A field with no value for a
      given node is simply left out of that node's "attr" dict rather than
      included as null, and "attr" itself is omitted entirely if none of the
      requested fields resolved to anything.
    - edge_attrs: same idea as node_attrs, but for edges - optional list of
      edge-attribute names to include under a nested "attr" dict on each
      edge. Unlike node attributes (which are naturally flat scalars/lists
      already sitting on each node), edge attributes must already be
      pre-aggregated into a flat value by whichever function built the graph
      (e.g. create_institution_keyword_network() attaching a flat
      'shared_keywords' list per edge) - this function does no aggregation
      of its own, it only passes through whatever's already on
      G_sub.edges[...][field]. A field absent or falsy on a given edge is
      left out of that edge's "attr" dict, same as node_attrs. Defaults to
      None - a no-op for every existing caller.
    - edge_type / role_suffix let the wording match what the nodes actually are
      (e.g. edge_type='co_publishes_with', role_suffix='shared papers' for
      institutions, vs. 'collaborates_with' / 'co-authors' for people).
    """

    if top_n is not None and G.number_of_nodes() > top_n:
        G_sub = build_connected_sample(G, target_size=top_n)
    else:
        G_sub = G

    if team_attribute:
        # Group by a real attribute already on the nodes (e.g. country),
        # instead of running community detection at all
        value_counts = Counter(
            G_sub.nodes[n].get(team_attribute) for n in G_sub.nodes()
            if G_sub.nodes[n].get(team_attribute)
        )
        kept_values = {v for v, c in value_counts.most_common(max_team_categories) if c >= min_team_size}

        def team_for(n):
            val = G_sub.nodes[n].get(team_attribute)
            if not val:
                return "unknown"
            return val if val in kept_values else "other"

        node_to_team = {n: team_for(n) for n in G_sub.nodes()}
    else:
        # Detect communities on the full input graph, not just the exported sample
        communities = list(greedy_modularity_communities(G)) if G.number_of_edges() > 0 else []
        communities_sorted = sorted(communities, key=len, reverse=True)
        node_to_team = {}
        for i, community in enumerate(communities_sorted):
            keep_separate = i < max_communities and len(community) >= min_community_size
            label = f"cluster_{i}" if keep_separate else "other"
            for node in community:
                node_to_team[node] = label

    nodes = []
    for n in G_sub.nodes():
        node_obj = {
            "id": n,
            "name": G_sub.nodes[n].get("display_name", n),
            "team": node_to_team.get(n, "other"),
            "role": f"{G_sub.degree(n)} {role_suffix}"
        }
        if node_attrs:
            attrs = {f: G_sub.nodes[n].get(f) for f in node_attrs if G_sub.nodes[n].get(f)}
            if attrs:
                node_obj["attr"] = attrs
        nodes.append(node_obj)

    edges = []
    for u, v, edata in G_sub.edges(data=True):
        edge_obj = {
            "source": u,
            "target": v,
            "type": edge_type,
            "weight": edata.get("weight", 1)
        }
        if edge_attrs:
            attrs = {f: edata.get(f) for f in edge_attrs if edata.get(f)}
            if attrs:
                edge_obj["attr"] = attrs
        edges.append(edge_obj)

    sample = {"nodes": nodes, "edges": edges}

    with open(filename, "w", encoding="utf-8") as f:
        json.dump(sample, f, indent=2, ensure_ascii=False)

    team_counts = Counter(n["team"] for n in nodes)
    print(f"Exported {len(nodes)} nodes and {len(edges)} edges to {filename}")
    print(f"Team breakdown: {dict(team_counts)}\n\n")
    return sample


def create_author_grouped_network(df, top_n=40, min_team_size=2, max_team_categories=10,
                                   filename='network_sample.json', team_attribute=None,
                                   node_attrs=('institution', 'department', 'city',),
                                   edge_attrs=None):
    """
    Build and export the author (co-authorship) network end-to-end from a
    raw, article-level df (one row per article - typically the output of
    filter_out_mega_papers()).

    Pass team_attribute='country' (or 'institution', 'institution_department')
    to group/color authors by that real attribute instead of algorithmically
    detected communities.

    node_attrs defaults to institution/department/city/author_keywords/keywords_plus -
    deliberately leaving out 'country' since that's typically the team_attribute above;
    no need to duplicate it inside "attr" as well.

    edge_attrs: optional list of pre-aggregated edge-attribute names to
    expose - see export_graph_to_json()'s edge_attrs docstring.
    create_author_network() attaches a flat 'article_titles' union onto
    each edge, so passing edge_attrs=('article_titles',) surfaces that in
    the export; defaults to None (no-op) so existing callers are
    unaffected unless they opt in.

    Returns:
    (G, sample) - the NetworkX author graph and the exported JSON-ready dict,
    so callers (e.g. main()'s custom co-author lookups) still have access to G.
    """
    df_exploded = extract_authors_with_metadata(df)

    # Resolve author identity via ORCID wherever possible, before building the graph
    df_exploded = resolve_author_ids(df_exploded)

    # Attach institution / department / country to each author-article row
    df_exploded = enrich_with_institution_data(df_exploded)

    # Split Author Keywords / Keywords Plus into clean lists, one per article
    df_exploded = parse_keyword_columns(df_exploded)

    # Author (co-authorship) network, keyed on ORCID where available
    G = create_author_network(df_exploded)

    sample = export_graph_to_json(
        G, filename=filename, top_n=top_n,
        edge_type='collaborates_with', role_suffix='co-authors',
        min_team_size=min_team_size, max_team_categories=max_team_categories,
        team_attribute=team_attribute, node_attrs=node_attrs, edge_attrs=edge_attrs
    )

    return G, sample




# Example usage
if __name__ == "__main__":
    # Execution : 
    print(" Execution WoS Analysis ... ")
    print(" Reading files ")
    df = combine_excel_files_method2('./WoS/')

    # General, article-level statistics about the source data (authors-per-article
    # creates ['autors_list'] field
    df = prepare_author_lists(df)

    # Exclude mega-papers (e.g. large consensus/guideline papers) so they don't
    # dominate the top-degree rankings with an artificial clique. Runs at the
    # article level, so it gates every relation built below, not just authors.
    df = filter_out_mega_papers(df, max_authors=15)

    # --- Author (co-authorship) network ---
    # Wraps the whole author-only chain (explode, ORCID resolution, institution
    # enrichment, keyword parsing, graph build, export) internally.
    G, out = create_author_grouped_network(
        df, top_n=700,
        filename='network_author.json',
        team_attribute='country',
        max_team_categories=22,
        min_team_size=2,
        node_attrs=('institution', 'department', 'city', 'author_keywords', 'keywords_plus'),
        edge_attrs=('article_titles',)
    )

    # --- Institution/department keyword-based collaboration network ---
    # A different relation from the co-publication one below - this one
    # works at the article level directly (no author-level explode needed):
    # nodes = institution-department (via the corresponding/reprint author),
    # edges = potential collaboration, weighted by the number of distinct
    # article pairs that share specific, non-generic keywords.
    df_institutions = prepare_article_institution_data(df)
    G_institution_keywords = create_institution_keyword_network(
        df_institutions, 
        group_column='institution_department',
        max_keyword_df=0.12, 
        min_shared_keywords=3
    )
    export_graph_to_json(
        G_institution_keywords, filename='network_institution_keywords.json',
        top_n=150, 
        edge_type='shares_keywords_with',
        role_suffix='keyword-linked institutions',
        team_attribute='country', 
        max_team_categories=12, 
        min_team_size=2,
        node_attrs=('institution', 'department', 'city'),
        edge_attrs=('shared_keywords',)
    )

    # --- Institution and department network (co-publication via shared authorship) ---
    # TODO: rework to run off article-institution-level data directly (see
    # project notes re: article-institution-address) instead of df_exploded,

    # G_institution_dept = create_grouped_network(df_exploded, 'institution_department')
    # analyze_grouped_network(G_institution_dept, label='institution/department')
    # export_graph_to_json(
    #     G_institution_dept, filename='network_by_institution.json', top_n=60,
    #     edge_type='co_publishes_with', role_suffix='shared papers',
    #     min_community_size=5, max_communities=7
    # )

    # --- Country-level (international collaboration) network ---
    # G_country = create_grouped_network(df_exploded, 'country')
    # analyze_grouped_network(G_country, label='countries')
    # export_graph_to_json(
    #     G_country, filename='network_by_country.json', top_n=None,
    #     edge_type='collaborates_with', role_suffix='shared papers',
    #     min_community_size=4, max_communities=7
    # )
    
    # Additional custom analysis
    print("\n" + "="*60)
    print("🔍 CUSTOM QUERIES")
    print("="*60)
    
    # Find an author's co-authors (lookup by display name, since the node
    # key itself may now be an ORCID rather than the name string)
    author_name = "Grech, Victor"
    author_id = find_author_id(G, author_name)
    if author_id:
        coauthors = list(G.neighbors(author_id))
        print(f"\n📌 Co-authors of {author_name}:")
        for coauthor in coauthors:
            weight = G[author_id][coauthor]['weight']
            articles = len(G[author_id][coauthor]['articles'])
            coauthor_name = G.nodes[coauthor].get('display_name', coauthor)
            print(f"   - {coauthor_name} (collaborated {weight} times, {articles} articles)")
    else:
        print(f"\n📌 {author_name} not found in this sample")
    
    # Find most collaborative pair
    max_edge = max(G.edges(data=True), key=lambda x: x[2]['weight'])
    name_a = G.nodes[max_edge[0]].get('display_name', max_edge[0])
    name_b = G.nodes[max_edge[1]].get('display_name', max_edge[1])
    print(f"\n📌 Most collaborative pair:")
    print(f"   {name_a} and {name_b}")
    print(f"   Collaborated {max_edge[2]['weight']} times")
    print(f"   Articles: {[a['title'] for a in max_edge[2]['articles']]}")
