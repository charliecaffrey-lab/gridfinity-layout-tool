import { useEffect, useRef } from 'react';
import { startKdEmbedBridge } from '@/shared/kdEmbed/bridge';
import { readKdParentOrigin } from '@/shared/kdEmbed/protocol';
import { kdExportPrintSet } from '@/shell/kdPrintSet/exportPrintSet';
import { useLayoutExport } from '@/shell/layoutExport/useLayoutExport';

/**
 * Kitchen Drawers fork: starts the embed bridge when the editor runs inside the
 * kitchen app's frame (`?kd=1&kdParent=<origin>`). Does nothing otherwise.
 */
export function KdEmbedRegistration(): null {
  const { exportLayout } = useLayoutExport();
  // The bridge outlives renders; it always calls the latest export function.
  const exportRef = useRef(exportLayout);
  useEffect(() => {
    exportRef.current = exportLayout;
  }, [exportLayout]);

  useEffect(() => {
    const parentOrigin = readKdParentOrigin(window.location.search);
    if (parentOrigin === null || window.parent === window) return;
    return startKdEmbedBridge(parentOrigin, window.parent, {
      exportPrintSet: (message) => kdExportPrintSet(message, exportRef.current),
    });
  }, []);
  return null;
}
