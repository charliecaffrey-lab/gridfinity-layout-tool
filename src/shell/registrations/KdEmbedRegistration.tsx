import { useEffect } from 'react';
import { startKdEmbedBridge } from '@/shared/kdEmbed/bridge';
import { readKdParentOrigin } from '@/shared/kdEmbed/protocol';

/**
 * Kitchen Drawers fork: starts the embed bridge when the editor runs inside the
 * kitchen app's frame (`?kd=1&kdParent=<origin>`). Does nothing otherwise.
 */
export function KdEmbedRegistration(): null {
  useEffect(() => {
    const parentOrigin = readKdParentOrigin(window.location.search);
    if (parentOrigin === null || window.parent === window) return;
    return startKdEmbedBridge(parentOrigin, window.parent);
  }, []);
  return null;
}
