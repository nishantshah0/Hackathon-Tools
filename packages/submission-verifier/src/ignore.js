// Paths whose line counts should not count toward "how much code did the
// team actually write" — lockfiles, vendored trees, build output, minified
// bundles. Used by the oversized-commit and burstiness checks.

export const IGNORE_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /(^|\/)vendored\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)out\//,
  /(^|\/)\.next\//,
  /(^|\/)__pycache__\//,
  /\.min\.(js|css)$/,
  /\.(lock|lockb)$/,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
];

export function isIgnoredPath(path) {
  return IGNORE_PATTERNS.some((re) => re.test(path));
}

/** Sum of added lines in a commit, excluding ignored paths. */
export function countedAddedLines(commit) {
  let total = 0;
  for (const f of commit.files) {
    if (!isIgnoredPath(f.path)) total += f.added;
  }
  return total;
}

/** Number of files touched by a commit, excluding ignored paths. */
export function countedFiles(commit) {
  return commit.files.filter((f) => !isIgnoredPath(f.path)).length;
}
