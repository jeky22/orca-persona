export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/')
  if (s.length > 1) s = s.replace(/\/+$/, '') || '/'
  return s.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`)
}

export function expandHome(pattern: string, home: string): string {
  if (pattern === '~') return home
  if (pattern.startsWith('~/') || pattern.startsWith('~\\')) return home + pattern.slice(1)
  return pattern
}

export function globToRegExp(pattern: string, home: string): RegExp {
  const p = normalizePath(expandHome(normalizePath(pattern), normalizePath(home)))
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        re += '(?:[^/]+/)*'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\/]/g, '\\$&')
  }
  // '/**' at the end also matches the base directory itself
  if (re.endsWith('\\/.*')) re = `${re.slice(0, -4)}(?:\\/.*)?`
  return new RegExp(`^${re}$`)
}

export function globMatches(pattern: string, path: string, home: string): boolean {
  return globToRegExp(pattern, home).test(normalizePath(path))
}
