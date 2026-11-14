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
| `src/shared/kdEmbed/protocol.ts`                   | Messages exchanged with the kitchen app. The kitchen app keeps a copy.      |
| `src/shared/kdEmbed/bridge.ts`                     | The embed bridge (see below).                                               |
| `src/shell/registrations/KdEmbedRegistration.tsx`  | Starts the bridge when the page is opened with `?kd=1&kdParent=<origin>`.   |

## The embed bridge

Our long-lived branch is `kitchen-drawers`; `main` stays a clean copy of upstream.

When the kitchen app shows this editor in a frame it opens
`/?kd=1&kdParent=<the kitchen app's origin>`. The bridge then:

1. sends `kd:ready` to the parent;
2. receives `kd:load` with a drawer id, name, measured inside size and the saved
   layout (or none), and opens it as that drawer's working copy. A saved layout
   is loaded without regenerating ids, so bin ids stay the same across saves;
3. sends `kd:changed` when the layout is edited;
4. answers `kd:get-layout` with the layout JSON, including any linked bin designs.

The kitchen app's database is the source of truth. This browser's library only
holds a working copy per drawer, which the next `kd:load` overwrites. Messages
are accepted only from the origin named in the URL and only from the parent window.

## Print sets

The kitchen app can ask for one drawer's print files with `kd:export-print-set`
(a file-name stem, `3mf` or `stl`, the printer's bed in mm, and an upload
address on the kitchen app's own origin). `src/shell/kdPrintSet/exportPrintSet.ts` then:

1. gives every plain bin a default bin design at its size and links it, because
   upstream only exports bins that have a design. Same-sized whole-unit bins
   share one design; half-unit bins get their own;
2. sets the layout's print bed to the printer's;
3. runs upstream's own whole-layout export, with its "also POST exports to a
   URL" setting pointed at the upload address for the length of that one call.

Nothing in upstream's export code is changed. The editor answers
`kd:print-set-done`; the browser also downloads the ZIP as upstream always does.

The bridge only reports `kd:changed` once the person has clicked or typed in
the editor: a freshly loaded layout with linked designs is adjusted by the
editor itself, and that is not an edit.

## Fitted bins

The kitchen app can ask for a bin fitted to one catalog item with
`kd:add-fitted-bin` (the item's size in mm, a pocket shape, clearance, pocket
depth and whether to add a finger notch). `src/shell/kdFitted/`:

- `fittedPlan.ts` (pure) picks the smallest bin whose inside holds the pocket
  plus clearance and 2 mm of plastic around it, and builds the design: a
  **solid** bin with one cutout. Shapes: rectangle, circle, a traced outline as
  a `path` cutout, or a stepped pocket using the cutout's `split`.
- `addFittedBin.ts` saves the design, adds a bin linked to it in the first free
  spot (or the stash when the drawer is full), and stamps the bin with
  `kd.minW`, `kd.minD` and `kd.itemId`, so the solver never squeezes it below
  its footprint and the kitchen app knows what it holds.

Trap: a solid bin needs `style: 'solid'` AND `base.solid: true`. With the style
alone the generator exports an ordinary hollow bin and silently drops the
pocket. Unit tests cannot see this; measure an exported STL.

New drawers also get interlocking baseplate connectors (`connectorNubs` with
the `puzzle` style), set in `kdLayoutFromMessage`, so the printed baseplate
pieces hold together. Existing layouts are left as they are.

## Upstream files we touch

| File                                                    | Change                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/hooks/interactions/useResizeInteraction.ts` | A single-bin resize asks the solver first; neighbors it moves are previewed and committed with the bin. Marked with `// kd:` comments. |
| `src/shared/hooks/interactions/useDragInteraction.ts`   | A pinned bin does not start a drag, and drops out of a group drag.                                                                     |
| `src/App.tsx`                                           | Mounts `KdSolverRegistration` and `KdEmbedRegistration` (four lines).                                                                  |
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

## Applying a plan from the kitchen app

`kd:apply-bins` carries a checked plan (bins to remove, bins to move or resize,
bins to add) and is answered with `kd:bins-applied`. `src/shell/kdApply/applyBins.ts`
applies it as one undo step. Removals are sent with source `cascade` so the
"Absorb" freed-space rule does not grow neighbors into space the plan is about
to reuse. The kitchen app has already run the plan through its copy of the
solver, so the editor does not solve again; anything the editor's own
validation still refuses is reported back by label.

## Cradle pockets

`kd:add-fitted-bin` also takes the shape `cradle`: `item.levels` is a list of
steps, deepest first, each with a cut depth and one or more outlines in a
shared frame. `fittedPlan.ts` turns every outline into its own path cutout cut
to that step's depth; the deeper ones sit inside the shallower ones, so the
pocket is a staircase. If the drawer is too low for the asked depth the plan
is refused rather than cut short, because a shallower cradle is a different
set of outlines and the kitchen app has to work it out again.
