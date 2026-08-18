# The plugin spawns fleets; it does not judge them

`fleet` stops at the point where every member is a running worktree with a booted box,
an auto-started agent, and the fleet task delivered. Comparing what the members
produced — held-out tests, rubrics, verdicts, results tables — stays outside the
plugin, in whatever harness wants it (today: the `harness-bench` skill, which keeps its
task, grader, and judge and rewrites only its spawn phase to call `fleet`).

The temptation is real, because a benchmark is the most obvious reason to run three
agents on one base ref, and the plugin will already know the member list and the task.
It is still the wrong home: grading needs a rubric, a held-out test, and an opinion
about what "better" means, none of which belong to a tool whose job is mirroring a
worktree into a sandbox. Keeping the seam here means a fleet is equally useful when
there is nothing to grade — three agents, one task, pick the diff you like.
