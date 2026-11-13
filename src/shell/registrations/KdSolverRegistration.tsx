import { commandBus } from '@/core/cqrs';
import { createKdCommandRules } from '@/shared/kdSolver/commandRules';

let registered = false;

/**
 * Kitchen Drawers fork: adds the solver's command rules (pinned bins, absorb on
 * delete) to the command bus once, when the app shell first renders. Done here
 * rather than at module load so the bus exists however the bundle is split.
 */
export function KdSolverRegistration(): null {
  if (!registered) {
    registered = true;
    commandBus.use(createKdCommandRules((command) => commandBus.dispatch(command)));
  }
  return null;
}
