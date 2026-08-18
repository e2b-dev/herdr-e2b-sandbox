# Fleet members start clean

`open` mirrors the live worktree, uncommitted changes and all — that is the feature.
`fleet` does not: each member is a fresh worktree off the base ref, so dirty work in the
checkout you launched from is left behind. When the tree is dirty at launch, the picker
says so ("N uncommitted files will not be carried") and continues.

This is the only place fleet deliberately behaves unlike `open`, so it will look like a
bug to whoever reads it next. It isn't: carrying a dirty tree into three branches
produces three divergent copies of work that has never been committed, and the first
agent to touch those files makes the copies unmergeable. Refusing to launch on a dirty
tree was rejected as too rigid — unrelated local scratch files are normal, and a warning
respects that while still making the drop visible.
