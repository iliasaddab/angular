/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as ir from '../../ir';
import type {ComponentCompilationJob} from '../compilation';

/**
 * Assign data slots for all operations which implement `ConsumesSlotOpTrait`, and propagate the
 * assigned data slots of those operations to any expressions which reference them via
 * `UsesSlotIndexTrait`.
 *
 * This phase is also responsible for counting the number of slots used for each view (its `decls`)
 * and propagating that number into the `Template` operations which declare embedded views.
 */
export function phaseSlotAllocation(job: ComponentCompilationJob): void {
  // Map of all declarations in all views within the component which require an assigned slot index.
  // This map needs to be global (across all views within the component) since it's possible to
  // reference a slot from one view from an expression within another (e.g. local references work
  // this way).
  const slotMap = new Map<ir.XrefId, number>();

  // Process all views in the component and assign slot indexes.
  for (const unit of job.units) {
    // Slot indices start at 0 for each view (and are not unique between views).
    let slotCount = 0;

    for (const op of unit.create) {
      // Only consider declarations which consume data slots.
      if (!ir.hasConsumesSlotTrait(op)) {
        continue;
      }

      // Assign slots to this declaration starting at the current `slotCount`.
      op.slot = slotCount;

      // And track its assigned slot in the `slotMap`.
      slotMap.set(op.xref, op.slot);

      // Each declaration may use more than 1 slot, so increment `slotCount` to reserve the number
      // of slots required.
      slotCount += op.numSlotsUsed;
    }

    // Record the total number of slots used on the view itself. This will later be propagated into
    // `ir.TemplateOp`s which declare those views (except for the root view).
    unit.decls = slotCount;
  }

  // After slot assignment, `slotMap` now contains slot assignments for every declaration in the
  // whole template, across all views. Next, look for expressions which implement
  // `UsesSlotIndexExprTrait` and propagate the assigned slot indexes into them.
  // Additionally, this second scan allows us to find `ir.TemplateOp`s which declare views and
  // propagate the number of slots used for each view into the operation which declares it.
  for (const unit of job.units) {
    for (const op of unit.ops()) {
      if (op.kind === ir.OpKind.Template || op.kind === ir.OpKind.RepeaterCreate) {
        // Record the number of slots used by the view this `ir.TemplateOp` declares in the
        // operation itself, so it can be emitted later.
        const childView = job.views.get(op.xref)!;
        op.decls = childView.decls;
      }

      if (ir.hasUsesSlotIndexTrait(op) && op.target !== null && op.targetSlot === null) {
        if (!slotMap.has(op.target)) {
          // We do expect to find a slot allocated for everything which might be referenced.
          throw new Error(
              `AssertionError: no slot allocated for ${ir.OpKind[op.kind]} target ${op.target}`);
        }

        op.targetSlot = slotMap.get(op.target)!;
      }

      // Process all `ir.Expression`s within this view, and look for `usesSlotIndexExprTrait`.
      ir.visitExpressionsInOp(op, expr => {
        if (!ir.isIrExpression(expr)) {
          return;
        }

        if (!ir.hasUsesSlotIndexTrait(expr) || expr.targetSlot !== null) {
          return;
        }

        // The `UsesSlotIndexExprTrait` indicates that this expression references something declared
        // in this component template by its slot index. Use the `target` `ir.XrefId` to find the
        // allocated slot for that declaration in `slotMap`.

        if (!slotMap.has(expr.target)) {
          // We do expect to find a slot allocated for everything which might be referenced.
          throw new Error(`AssertionError: no slot allocated for ${expr.constructor.name} target ${
              expr.target}`);
        }

        // Record the allocated slot on the expression.
        expr.targetSlot = slotMap.get(expr.target)!;
      });
    }
  }
}
