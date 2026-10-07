// SPDX-License-Identifier: AGPL-3.0-or-later
import { conflict } from '../../core/errors';

/** Map SQLite UNIQUE violations to a readable 409. */
export async function uniqueName<T>(p: Promise<T>, what = 'name'): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err))) {
      throw conflict('name_taken', `That ${what} is already in use`);
    }
    throw err;
  }
}
