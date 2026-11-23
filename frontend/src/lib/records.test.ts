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

  it("highlights matches ignoring accents and case, as the server does", () => {
    // A term "i" or "I" matches "Í", "í", "İ" and "ì"; "Í" or "İ" matches a plain "i".
    for (const term of ["i", "I"]) {
      expect(marked("Í í İ ì", "x", "contains", term)).toEqual(["Í", "í", "İ", "ì"]);
    }
    for (const term of ["Í", "İ"]) {
      expect(marked("Pisa", "x", "contains", term)).toEqual(["i"]);
    }
    expect(marked("ÍNDIA; İzmir", "Addresses", "contains", "india; IZMIR")).toEqual([
      "ÍNDIA",
      "İzmir",
    ]);
    // The marks land on the original text, accents written as combining marks too.
    expect(marked("Universite\u0301 Paris", "x", "contains", "université")).toEqual([
      "Universite\u0301",
    ]);
    expect(marked("Núñez, José; Øster, Åsa", "x", "contains", "nunez; oster")).toEqual([
      "Núñez",
      "Øster",
    ]);
    expect(marked("Großmann", "x", "contains", "grossmann")).toEqual(["Großmann"]);
    // Exactly PostgreSQL's unaccent table: what it folds, and only that.
    expect(marked("ƒ; ǆ", "x", "contains", "f; dz")).toEqual(["ƒ", "ǆ"]);
    expect(marked("ǽ; й", "x", "contains", "ae; и")).toEqual([]);
    expect(marked("и\u0306", "x", "contains", "и")).toEqual(["и\u0306"]);
    // Lower-cased per character, as PostgreSQL does: a final "Σ" is "σ", not "ς".
    expect(marked("ΟΔΟΣ", "x", "contains", "οδοσ")).toEqual(["ΟΔΟΣ"]);
    // "has item" folds items and terms alike; keyword columns still treat hyphens as spaces.
    expect(marked("Núñez, José; Nunez, J", "x", "has_item", "NUNEZ, JOSE")).toEqual([
      "Núñez, José",
    ]);
    expect(marked("Ál-Gebra; Algebra", "Author Keywords", "has_item", "al gebra")).toEqual([
      "Ál-Gebra",
    ]);
    expect(marked("SÉLF–SUPERVISED", "Keywords Plus", "contains", "self supervised")).toEqual([
      "SÉLF–SUPERVISED",
    ]);
  });
});
