import type { Network } from "../lib/network";

/**
 * Small network covering every visibility rule:
 * - teams Italy / USA / other, relation types collaborates_with / shares_keywords_with
 * - list and scalar attributes on nodes and edges
 * - "z" has no edges at all (exempt from edge-attribute cascading)
 */
export function sampleNetwork(): Network {
  return {
    nodes: [
      {
        id: "a",
        name: "Rossi, Anna",
        team: "Italy",
        role: "2 co-authors",
        attr: { institution: "Univ Parma", author_keywords: ["Fetal ultrasound", "Deep learning"] },
      },
      {
        id: "b",
        name: "Bianchi, Marco",
        team: "Italy",
        role: "2 co-authors",
        attr: { institution: "Univ Parma", author_keywords: ["deep learning"] },
      },
      {
        id: "c",
        name: "Lee, Kim",
        team: "USA",
        role: "2 co-authors",
        attr: { institution: "Mayo Clin", city: "Rochester" },
      },
      { id: "d", name: "Wang, Li", team: "other", role: "1 co-authors" },
      {
        id: "z",
        name: "Solo, Han",
        team: "USA",
        role: "0 co-authors",
        attr: { institution: "Mayo Clin" },
      },
    ],
    edges: [
      {
        source: "a",
        target: "b",
        type: "collaborates_with",
        weight: 2,
        attr: { article_titles: ["Fetal imaging with AI"] },
      },
      {
        source: "a",
        target: "c",
        type: "collaborates_with",
        weight: 1,
        attr: { article_titles: ["Ultrasound review"] },
      },
      {
        source: "b",
        target: "c",
        type: "shares_keywords_with",
        weight: 1,
        attr: { shared_keywords: ["deep learning"] },
      },
      { source: "c", target: "d", type: "collaborates_with", weight: 1 },
    ],
  };
}
