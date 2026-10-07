// SPDX-License-Identifier: AGPL-3.0-or-later
/** Push sender wiring. Web Push itself is implemented with WebCrypto in src/modules/push (M7). */
import type { AppConfig } from '../../core/config';
import type { PushSender } from '../../core/ports';

export function pushSender(_config: AppConfig): PushSender | null {
  return null;
}
