import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planEqualWidths, balanceOwnedPanes, __setLayoutRequestForTest__ } from "../pi-extension/subagents/herdr-layout.ts";

const pane = (pane_id: string) => ({ type: "pane" as const, pane_id });
const split = (first: any, second: any, ratio = 0.5, direction = "right") => ({ type: "split" as const, direction, ratio, first, second });

describe("Herdr equal-width layout", () => {
  it("uses leaf counts, not 50/50 at every split", () => {
    const root = split(split(pane("parent"), pane("third")), pane("second"));
    assert.deepEqual(planEqualWidths(root, "parent", new Set(["second", "third"]), 90), [
      { path: [], ratio: 2 / 3 },
    ]);
  });

  it("balances only the caller's owned subtree, preserving unrelated panes", () => {
    const root = split(pane("unrelated"), split(split(pane("parent"), pane("third")), pane("second")));
    assert.deepEqual(planEqualWidths(root, "parent", new Set(["second", "third"]), 135), [
      { path: [true], ratio: 2 / 3 },
    ]);
    assert.deepEqual(planEqualWidths(root, "parent", new Set(["second", "third"]), 135, 12,
      new Map([["parent", { x: 100, width: 10 }], ["third", { x: 110, width: 10 }], ["second", { x: 120, width: 10 }]])), []);
  });

  it("skips zoom-like mixed orientations, missing panes and insufficient width", () => {
    const mixed = split(split(pane("parent"), pane("third"), 0.5, "down"), pane("second"));
    assert.deepEqual(planEqualWidths(mixed, "parent", new Set(["second", "third"]), 135), []);
    assert.deepEqual(planEqualWidths(split(pane("parent"), pane("unrelated")), "parent", new Set(["missing"]), 135), []);
    assert.deepEqual(planEqualWidths(split(pane("parent"), pane("second")), "parent", new Set(["second"]), 18), []);
  });

  it("uses explicit tab and caller targets; skips a zoomed tab", async () => {
    const prev = { HERDR_ENV: process.env.HERDR_ENV, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = "/dummy";
    const root = split(split(pane("parent"), pane("third")), pane("second"));
    const requests: Array<[string, Record<string, unknown>]> = [];
    let zoomed = false;
    const restore = __setLayoutRequestForTest__(async (method, params) => {
      requests.push([method, params]);
      if (method === "layout.export") return { layout: { root, tab_id: "tab-owned", zoomed } };
      if (method === "pane.layout") return { layout: { tab_id: "tab-owned", zoomed, area: { width: 135 }, panes: [
        { pane_id: "parent", rect: { x: 0, width: 34 } },
        { pane_id: "third", rect: { x: 34, width: 34 } },
        { pane_id: "second", rect: { x: 68, width: 67 } },
      ] } };
      return { type: "layout_split_ratio_set" };
    });
    try {
      await balanceOwnedPanes("parent", new Set(["second", "third"]));
      assert.deepEqual(requests, [
        ["layout.export", { pane_id: "parent" }],
        ["pane.layout", { pane_id: "parent" }],
        ["layout.set_split_ratio", { tab_id: "tab-owned", path: [], ratio: 2 / 3 }],
      ]);
      requests.length = 0;
      zoomed = true;
      await balanceOwnedPanes("parent", new Set(["second", "third"]));
      assert.deepEqual(requests, [["layout.export", { pane_id: "parent" }]]);
    } finally {
      restore();
      for (const key of ["HERDR_ENV", "HERDR_SOCKET_PATH"] as const) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  });
});
