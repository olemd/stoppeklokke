// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppConfig } from '../../core/config';
import type { Clock, PushSender } from '../../core/ports';
import { createPushSender } from './webpush';

/** A push sender when all VAPID values are configured, otherwise null (push off). */
export function pushSenderFromConfig(config: AppConfig, clock: Clock): PushSender | null {
  const {
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: privateKey,
    VAPID_SUBJECT: subject,
  } = config;
  if (!publicKey || !privateKey || !subject) return null;
  return createPushSender({ publicKey, privateKey, subject }, () => clock.now());
}
