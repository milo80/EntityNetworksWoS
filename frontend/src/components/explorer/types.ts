/** What is selected in the graph. */
export type Selection = { kind: "node"; id: string } | { kind: "edge"; index: number };
