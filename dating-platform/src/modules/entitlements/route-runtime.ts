import { auth } from "@/modules/auth/auth";

import { entitlementService } from "./runtime";

export const entitlementRouteDependencies = {
  getSession: (headers: Headers) => auth.api.getSession({ headers }),
  service: entitlementService,
};
