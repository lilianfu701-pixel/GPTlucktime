import { z } from "zod";
import { correlationIdFrom, jsonError, jsonSuccess, jsonUnprocessable } from "@/lib/api";
import { flags } from "@/lib/feature-flags";
import { DEFAULT_LIMIT, MAX_LIMIT, searchMemorials } from "@/modules/search/query";

const schema = z.object({
  q: z.string().max(200).optional(),
  birthYear: z.coerce.number().int().min(1583).max(2200).optional(),
  deathYear: z.coerce.number().int().min(1583).max(2200).optional(),
  country: z.string().length(2).optional(),
  cursor: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

/**
 * Public memorial search.
 *
 * No authentication: public memorials are public. The privacy conditions are
 * enforced inside the query rather than here, so this handler cannot be the
 * place a filter is forgotten.
 */
export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFrom(request);

  if (!flags().publicSearchEnabled) {
    return jsonError("FEATURE_DISABLED", correlationId);
  }

  const url = new URL(request.url);
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));

  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".") || "_";
      fieldErrors[field] ??= [];
      fieldErrors[field].push(issue.message);
    }
    return jsonUnprocessable(correlationId, fieldErrors);
  }

  const result = await searchMemorials({
    ...parsed.data,
    limit: parsed.data.limit ?? DEFAULT_LIMIT,
  });

  if (!result.ok) {
    return jsonUnprocessable(
      correlationId,
      result.error === "QUERY_TOO_SHORT"
        ? { q: ["Enter at least two characters."] }
        : { q: ["Enter a name, a year or a country to search for."] },
    );
  }

  return jsonSuccess(
    { results: result.value.hits, nextCursor: result.value.nextCursor },
    correlationId,
  );
}
