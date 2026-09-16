import assert from "node:assert/strict";
import test from "node:test";

import { formatSnapshot } from "../dist/src/linux-host.js";

const nodes = [
  {
    nodeId: "root",
    role: { value: "RootWebArea" },
    name: { value: "Example" },
    backendDOMNodeId: 1,
    childIds: ["button"],
  },
  {
    nodeId: "button",
    role: { value: "button" },
    name: { value: "Go" },
    backendDOMNodeId: 2,
    childIds: ["text"],
  },
  {
    nodeId: "text",
    role: { value: "StaticText" },
    name: { value: "Go" },
    backendDOMNodeId: 3,
    childIds: ["inline"],
  },
  {
    nodeId: "inline",
    role: { value: "InlineTextBox" },
    name: { value: "Go" },
    backendDOMNodeId: 4,
  },
];

test("Linux snapshots convert Chromium AX nodes into Ego refs", () => {
  const result = formatSnapshot(nodes, {});

  assert.equal(
    result.content,
    'root "Example" [ref=e2]\n  button "Go" [ref=e1]\n    text "Go"',
  );
  assert.deepEqual(result.refs, [
    { refId: "e1", backendNodeId: 2, role: "button", name: "Go" },
    { refId: "e2", backendNodeId: 1, role: "root", name: "Example" },
  ]);
});

test("Linux interactive snapshots retain tree context", () => {
  const result = formatSnapshot(nodes, { interactiveOnly: true });

  assert.equal(result.content, 'root\n  button "Go" [ref=e1]');
  assert.deepEqual(result.refs, [
    { refId: "e1", backendNodeId: 2, role: "button", name: "Go" },
  ]);
});
