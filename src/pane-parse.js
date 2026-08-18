#!/usr/bin/env node
// pane-parse.js — read a herdr JSON reply on stdin and print the one thing the
// caller needs, in a shape a shell can consume directly. Used by
// bin/e2b-dash-toggle, which runs inside a keybinding: it must never prompt,
// never hang, and never emit something `read -r a b c` can't fill.
//
// Modes:
//   panes <title>  one line, three space-separated fields:
//                  "<focused_pane> <dashboard_pane> <tab_pane_ids>",
//                  "-" for any absent value, tab ids comma-separated.
//   procs          foreground process names, one per line (nothing if none).
//
// Empty or malformed input is an ordinary outcome here — herdr isn't running,
// or the call failed — not an error: `panes` still prints its three
// placeholders, so the caller's `read` always fills every field.
import { readFileSync } from "node:fs";

const [mode, title] = process.argv.slice(2);

let doc = null;
try {
  doc = JSON.parse(readFileSync(0, "utf8"));
} catch {
  doc = null;
}

// "<focused> <own> <mates>" — see the contract above.
function panesLine(title) {
  const panes = doc?.result?.panes;
  if (!Array.isArray(panes)) return "- - -";
  const focused = panes.find((p) => p?.focused);
  const tab = focused?.tab_id;
  // A dashboard opened as its own pane (the toggle's busy-pane fallback).
  const own = panes.find((p) => p?.label === title);
  const mates =
    tab == null
      ? []
      : panes.filter((p) => p?.tab_id === tab).map((p) => p?.pane_id).filter((id) => id != null);
  return [focused?.pane_id ?? "-", own?.pane_id ?? "-", mates.length ? mates.join(",") : "-"].join(" ");
}

// process.exit() can truncate a pipe mid-write, so set exitCode and fall out.
if (mode === "panes") {
  console.log(panesLine(title));
} else if (mode === "procs") {
  for (const p of doc?.result?.process_info?.foreground_processes ?? []) {
    console.log(p?.name ?? "");
  }
} else {
  console.error(`pane-parse: unknown mode '${mode ?? ""}' (expected 'panes' or 'procs')`);
  process.exitCode = 2;
}
