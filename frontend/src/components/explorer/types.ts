/** What is selected, and where the click came from (graph or details list). */
export type Selection =
  | { kind: "node"; id: string; from: "graph" | "list" }
  | { kind: "edge"; index: number; from: "graph" | "list" };
