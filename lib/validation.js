import path from "node:path";

export function resolveWithinBase(baseDir, candidatePath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedBase, resolvedCandidate);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedCandidate;
  }

  throw new Error(`Path "${candidatePath}" resolves outside the allowed directory "${resolvedBase}".`);
}

export function isPathWithinAllowedRoots(candidatePath, allowedRoots) {
  const resolvedCandidate = path.resolve(candidatePath);
  return allowedRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
  });
}
