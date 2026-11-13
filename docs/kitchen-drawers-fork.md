# Kitchen Drawers fork notes

This fork adds a layout solver to the planner for the Kitchen Drawers project.
Everything of ours lives in new files, apart from the small edits listed under
"Upstream files we touch". Keep that list short: it is what has to be re-checked
on every merge from upstream.

## What the solver adds

- **Resize modes** (sidebar, "Neighbors"): Push (neighbors slide over if there is
  room), Squeeze (neighbors shrink, never below their minimum), Fixed (stop at
  the first neighbor). Default is Push.
- **Freed space**: Leave gap (default) or Absorb (the neighbor on that side takes
  the space a bin gives up, on shrink and on single-bin delete).
- **Pins**: a locked bin cannot be moved, pushed, squeezed or resized. Upstream's
  lock only freezes size.
- **Minimum sizes**: a bin's custom properties `kd.minW` and `kd.minD` (grid
  units) set the smallest footprint it may be resized or squeezed to. Without
  them the minimum is 1 x 1.
- **Fill empty space** with a largest-bin limit, replacing nothing upstream: it is
  a second button in our panel.
- **Reasons**: when a resize is held back, a toast names the bin or the minimum
  that stopped it.

## Our files

| File                                               | Purpose                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/shared/kdSolver/solver.ts`                    | The solver. Pure TypeScript, no imports, so a server can run the same file. |
| `src/shared/kdSolver/editor.ts`                    | Bridge between the planner's layout types and the solver.                   |
| `src/shared/kdSolver/commandRules.ts`              | Command-bus rules: pinned bins cannot move; Absorb on delete.               |
| `src/shared/kdSolver/settings.ts`                  | Mode settings, saved in the browser.                                        |
| `src/shared/kdSolver/KdSolverPanel.tsx`            | The sidebar controls. English only, on purpose: no locale files touched.    |
| `src/shell/registrations/KdSolverRegistration.tsx` | Adds the command rules to the bus.                                          |
| `src/shared/kdSolver/*.test.ts`                    | Tests for all of the above.                                                 |

## Upstream files we touch

| File                                                    | Change                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/hooks/interactions/useResizeInteraction.ts` | A single-bin resize asks the solver first; neighbors it moves are previewed and committed with the bin. Marked with `// kd:` comments. |
| `src/shared/hooks/interactions/useDragInteraction.ts`   | A pinned bin does not start a drag, and drops out of a group drag.                                                                     |
| `src/App.tsx`                                           | Mounts `KdSolverRegistration` (two lines).                                                                                             |
| `src/shell/Sidebar/Sidebar.tsx`                         | Mounts `KdSolverPanel` (import plus one element).                                                                                      |

## Known limits

- Typing a new width or depth in the inspector, and resizing several selected
  bins at once, still use upstream's rules (the change is refused if it does not
  fit). Only single-bin handle drags go through the solver.
- Moving a bin never pushes others.
- The solver looks at one layer. A bin stacked on a higher layer does not follow
  a bin that is pushed out from under it; upstream's placement check rejects such
  a plan and the resize falls back to upstream behavior.
- The panel is in the desktop sidebar only, not the phone or tablet layouts. The
  modes themselves apply everywhere.

## Working on it

The project needs Node 26 and pnpm, which this server runs through Docker:

```bash
# Build the image (what the kitchen app shows in its frame)
docker build -t kd-layout-tool:solver .

# Run the solver tests
pnpm exec vitest run src/shared/kdSolver
```

Commit with `git commit --no-verify`: the pre-commit hooks call pnpm, which is
not installed on the host. Run type-check, lint and tests in Docker first.
