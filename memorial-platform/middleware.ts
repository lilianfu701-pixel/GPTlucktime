import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  /**
   * Pages only.
   *
   * `/api` is excluded on purpose: an API answers in the language the caller
   * asks for, and rewriting its path would break every client. Static assets and
   * anything with a file extension are excluded so the middleware does not run
   * on images and fonts.
   */
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
