import { assert, test } from 'orca/testing'
import { globMatches, globToRegExp, normalizePath } from './glob'

const home = '/Users/me'

test('~/workspace/** matches nested paths and the base itself', () => {
  assert.equal(globMatches('~/workspace/**', '/Users/me/workspace/glab-server', home), true)
  assert.equal(globMatches('~/workspace/**', '/Users/me/workspace', home), true)
  assert.equal(globMatches('~/workspace/**', '/Users/me/workspaces/x', home), false)
})

test('* stays within one segment', () => {
  assert.equal(globMatches('~/side/*', '/Users/me/side/a', home), true)
  assert.equal(globMatches('~/side/*', '/Users/me/side/a/b', home), false)
})

test('windows separators and drive-letter case are normalized', () => {
  assert.equal(globMatches('C:/Users/me/work/**', 'c:\\Users\\me\\work\\repo', 'C:/Users/me'), true)
  assert.equal(normalizePath('C:\\Users\\me\\'), 'c:/Users/me')
  assert.equal(normalizePath('/'), '/')
})

test('trailing slash on the path is ignored', () => {
  assert.equal(globMatches('~/w/**', '/Users/me/w/repo/', home), true)
})

test('regex metacharacters are literal', () => {
  assert.equal(globToRegExp('~/a.b/**', home).test('/Users/me/aXb/z'), false)
  assert.equal(globToRegExp('~/a.b/**', home).test('/Users/me/a.b/z'), true)
})

test('? matches one non-separator char; other case is preserved', () => {
  assert.equal(globMatches('~/a?', '/Users/me/ab', home), true)
  assert.equal(globMatches('~/a?', '/Users/me/a/', home), false)
  assert.equal(globMatches('~/Work', '/Users/me/work', home), false)
})
