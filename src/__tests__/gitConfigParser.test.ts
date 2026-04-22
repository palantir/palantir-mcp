/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import fs from 'fs'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseGitToken } from '../utils/gitConfigParser.js'

vi.mock('fs')

const FOUNDRY_GIT_CONFIG = `[core]
\trepositoryformatversion = 0
\tfilemode = true
[remote "origin"]
\turl = https://user:my-secret-token@example.palantirfoundry.com/stemma/git/ri.stemma.main.repository.abc123
\tfetch = +refs/heads/*:refs/remotes/origin/*
`

const NON_FOUNDRY_GIT_CONFIG = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = git@github.com:user/repo.git
`

describe('parseGitToken', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should extract token from Foundry git config', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'statSync').mockReturnValue({
      isDirectory: () => true,
      isFile: () => false,
    } as fs.Stats)
    vi.spyOn(fs, 'readFileSync').mockReturnValue(FOUNDRY_GIT_CONFIG)

    expect(parseGitToken('/project')).toBe('my-secret-token')
  })

  it('should return undefined when no .git directory exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)

    expect(parseGitToken('/project')).toBeUndefined()
  })

  it('should return undefined for non-Foundry git repos', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'statSync').mockReturnValue({
      isDirectory: () => true,
      isFile: () => false,
    } as fs.Stats)
    vi.spyOn(fs, 'readFileSync').mockReturnValue(NON_FOUNDRY_GIT_CONFIG)

    expect(parseGitToken('/project')).toBeUndefined()
  })

  it('should return undefined when git config has no remote URL', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'statSync').mockReturnValue({
      isDirectory: () => true,
      isFile: () => false,
    } as fs.Stats)
    vi.spyOn(fs, 'readFileSync').mockReturnValue('[core]\n\tfilemode = true\n')

    expect(parseGitToken('/project')).toBeUndefined()
  })

  it('should handle git worktrees', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const pathStr = p.toString()
      if (pathStr.endsWith('.git')) return true
      if (pathStr.endsWith('commondir')) return false
      if (pathStr.endsWith('config')) return true
      return false
    })
    vi.spyOn(fs, 'statSync').mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
    } as fs.Stats)
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      const pathStr = p.toString()
      if (pathStr.endsWith('.git')) {
        return 'gitdir: /main-repo/.git/worktrees/my-worktree'
      }
      return FOUNDRY_GIT_CONFIG
    })

    expect(parseGitToken('/project')).toBe('my-secret-token')
  })
})
