// The attach-or-create decision — pure data in, one instruction out (ADR-0008).
// attach.js does the I/O; everything worth getting wrong is decided here, over
// literals, so every edge is testable without booting a box.

/** The env var a terminal is stamped with at creation, carrying its box key.
 * Exported so the writer (attach.js) and this validator can never drift. */
export const TERMINAL_MARKER = "HERDR_E2B_TERMINAL"

/**
 * Decide whether to reattach to the box's recorded terminal or create a fresh
 * one, and how to make it repaint.
 *
 *   rec       the record's terminal fields: { terminalPid, terminalCols, terminalRows }
 *   processes the box's live process listing (`commands.list()`)
 *   pane      this pane's dimensions: { cols, rows }
 *   key       the box key the terminal must be stamped with
 *
 * Returns { action: "create", reason } or { action: "attach", pid, resize }.
 *
 * The reasons matter to the user, not just the caller: "none" is a fresh box
 * doing the normal thing, while "died" and "recycled" mean the terminal they
 * left is not coming back — the one case worth a printed line.
 *
 * Validation before trust: a pid alone proves nothing, because pids are
 * recycled — the process must still exist AND carry this box's marker, or an
 * eventual reattach would hand the user a stranger's process with no error at
 * all. Hence "recycled" for a wrong or missing marker.
 *
 * The resize plan doubles as the repaint nudge. A reattached terminal replays
 * nothing (the sandbox runtime buffers no output), and only a window-change
 * signal makes a full-screen program redraw its frame (research q4/q8):
 *   - pane differs from the terminal's recorded size → one one-way resize:
 *     the fit and the nudge are the same SIGWINCH;
 *   - pane matches → no resize would fire, so go away and back, ending exactly
 *     where the pane is. Unknown recorded geometry counts as "differs" — one
 *     resize to the pane is correct whether or not it was already that size.
 */
export function planAttach(rec, processes, pane, key) {
  const pid = rec?.terminalPid
  if (!pid) return { action: "create", reason: "none" }
  const proc = (processes || []).find((p) => p.pid === pid)
  if (!proc) return { action: "create", reason: "died" }
  if (proc.envs?.[TERMINAL_MARKER] !== key) return { action: "create", reason: "recycled" }

  const sameSize = rec.terminalCols === pane.cols && rec.terminalRows === pane.rows
  const resize = sameSize
    ? [{ cols: pane.cols, rows: pane.rows > 1 ? pane.rows - 1 : pane.rows + 1 }, { cols: pane.cols, rows: pane.rows }]
    : [{ cols: pane.cols, rows: pane.rows }]
  return { action: "attach", pid, resize }
}
