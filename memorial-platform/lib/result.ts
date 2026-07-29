/**
 * The shared outcome type for every domain service.
 *
 * Domain services never throw for expected business outcomes; they return a
 * `Result` carrying a stable error code. Only genuinely exceptional conditions
 * (a lost database connection, a programming mistake) throw.
 *
 * See docs/memorial-platform/02-system-architecture.md section 4.
 */
export type Result<T, E extends string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function err<E extends string>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

export function isOk<T, E extends string>(
  result: Result<T, E>,
): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E extends string>(
  result: Result<T, E>,
): result is { ok: false; error: E } {
  return !result.ok;
}

/**
 * Returns the success value, or `fallback` when the result is a failure.
 *
 * Discriminates on `result.ok` rather than on the truthiness of `value`, so a
 * legitimate `0`, `false`, `null` or `""` is returned instead of the fallback.
 */
export function unwrapOr<T, E extends string>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
