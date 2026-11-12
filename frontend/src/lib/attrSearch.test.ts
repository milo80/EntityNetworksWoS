import { describe, expect, it } from "vitest";

import {
  addRow,
  initialRows,
  keyOptions,
  removeRow,
  setRowKey,
  setRowValue,
  unusedKeys,
} from "./attrSearch";

const KEYS = ["city", "institution", "keywords"];

describe("attribute search rows", () => {
  it("starts with one empty row for the first key, none without attributes", () => {
    expect(initialRows(KEYS)).toEqual([{ key: "city", value: "" }]);
    expect(initialRows([])).toEqual([]);
  });

  it("adds rows for unused keys only, until none remain", () => {
    let rows = initialRows(KEYS);
    rows = addRow(rows, KEYS);
    rows = addRow(rows, KEYS);
    expect(rows.map((r) => r.key)).toEqual(KEYS);
    expect(unusedKeys(rows, KEYS)).toEqual([]);
    expect(addRow(rows, KEYS)).toEqual(rows);
  });

  it("clears the value when the attribute changes", () => {
    let rows = setRowValue(initialRows(KEYS), 0, "Rome");
    expect(rows[0]).toEqual({ key: "city", value: "Rome" });
    rows = setRowKey(rows, 0, "institution");
    expect(rows[0]).toEqual({ key: "institution", value: "" });
  });

  it("offers each row its own key plus keys unused elsewhere", () => {
    const rows = [
      { key: "city", value: "" },
      { key: "keywords", value: "" },
    ];
    expect(keyOptions(rows, KEYS, 0)).toEqual(["city", "institution"]);
    expect(keyOptions(rows, KEYS, 1)).toEqual(["institution", "keywords"]);
  });

  it("removes a row by index", () => {
    const rows = addRow(initialRows(KEYS), KEYS);
    expect(removeRow(rows, 0)).toEqual([{ key: "institution", value: "" }]);
  });
});
