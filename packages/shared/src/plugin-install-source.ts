/**
 * @fileoverview Classify a plugin install source as a filesystem path or an
 * npm package specifier.
 *
 * `POST /api/plugins/install` routes on `isLocalPath`: without it the server
 * hands the string to `npm install`, which for a directory path fails with a
 * bare `ENOENT ... package.json` that names npm rather than the real problem.
 * Callers that accept a free-text install source must therefore decide the
 * branch themselves, and the CLI and the Plugin Manager must decide it the
 * same way — a path that installs from the terminal and not from the settings
 * page is the confusing case this module exists to prevent.
 */

/**
 * Whether an install source is written as a filesystem path.
 *
 * Recognizes POSIX absolute paths, Windows absolute paths, explicit relative
 * prefixes in either separator style, and `~` home expansion. npm package
 * names cannot take any of these forms: a leading `/` or `.` is invalid in an
 * npm name, and a scoped name starts with `@`.
 *
 * @param source - The raw install source string, as typed
 */
export function isPluginInstallPathSyntax(source: string): boolean {
  const trimmed = source.trim();
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith(".\\") ||
    trimmed.startsWith("..\\") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  );
}
