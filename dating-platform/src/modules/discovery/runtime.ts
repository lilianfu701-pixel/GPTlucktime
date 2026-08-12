import { DrizzleModerationContentPolicy } from "@/modules/moderation/content-policy";
import { DrizzleModerationRestrictionPolicy } from "@/modules/moderation/restriction-policy";

import { DiscoveryRepository } from "./discovery-repository";

export function createProductionDiscoveryRepository(database: unknown, options: {
  cursorSecret: string;
  disabledCountryCodes?: readonly string[];
  clock?: () => Date;
}) {
  return new DiscoveryRepository(database, {
    ...options,
    restrictionPolicy: new DrizzleModerationRestrictionPolicy(),
    contentPolicy: new DrizzleModerationContentPolicy(),
  });
}
