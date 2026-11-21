import { describe, expect, it } from "vitest";

import { highlight } from "./records";

const marked = (text: string, column: string, op: "contains" | "has_item", value: string) =>
  highlight(text, column, [{ column, op, value }])
    .filter((s) => s.mark)
    .map((s) => s.text);

describe("highlight", () => {
  it("marks contained text case-insensitively, and whole items for has item", () => {
    expect(marked("Deep learning; deep sea", "Author Keywords", "contains", "DEEP")).toEqual([
      "Deep",
      "deep",
    ]);
    expect(
      marked("Machine-Learning; learning", "Author Keywords", "has_item", "machine learning"),
    ).toEqual(["Machine-Learning"]);
    expect(marked("Univ Parma", "Other column", "contains", "parma")).toEqual(["Parma"]);
  });

  it("keeps the original characters when lower-casing changes the length", () => {
    // "İ".toLowerCase() is two characters long: indices must map back.
    expect(
      marked("İstanbul Univ; Ankara Univ", "Institutions (parsed)", "contains", "ankara"),
    ).toEqual(["Ankara"]);
    expect(marked("İİİ stanbul", "x", "contains", "stan")).toEqual(["stan"]);
    expect(marked("İzmir", "x", "contains", "i̇zmir")).toEqual(["İzmir"]);
  });

  it("treats hyphens as spaces in keyword columns only, as the server does", () => {
    expect(
      marked("MACHINE-LEARNING; NEURAL NETS", "Keywords Plus", "contains", "machine learning"),
    ).toEqual(["MACHINE-LEARNING"]);
    expect(marked("machine learning", "Author Keywords", "contains", "Machine-Learning")).toEqual([
      "machine learning",
    ]);
    expect(
      marked("A machine-learning study", "Article Title", "contains", "machine learning"),
    ).toEqual([]);
  });
});
