// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The registered module list, readable from modules that need to see the
 * others (export/import collects `exportCollections`) without an import cycle
 * through src/modules/index.ts.
 */
import type { Module } from './types';

let registered: Module[] = [];

export function setModules(list: Module[]): void {
  registered = list;
}

export function getModules(): Module[] {
  return registered;
}
