/*
 * Copyright (c) 2025 Palantir Technologies
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import fs from 'fs'
import path from 'path'

/**
 * Resolves the path to the git config file, handling both regular git repositories
 * and git worktrees.
 *
 * In a regular git repo, .git is a directory containing the config file.
 * In a git worktree, .git is a file containing a path to the actual git directory.
 * Example .git file content: "gitdir: /path/to/main/repo/.git/worktrees/worktree-name"
 */
function resolveGitConfigPath(gitProjectPath: string): string {
  const gitPath = path.join(gitProjectPath, '.git')

  if (!fs.existsSync(gitPath)) {
    throw Error(`No .git directory or file found at ${gitPath}`)
  }

  const stats = fs.statSync(gitPath)

  if (stats.isDirectory()) {
    // Regular git repository
    return path.join(gitPath, 'config')
  }

  if (stats.isFile()) {
    // Git worktree - .git is a file pointing to the actual git directory
    const gitFileContent = fs.readFileSync(gitPath, 'utf-8').trim()
    const gitdirMatch = gitFileContent.match(/^gitdir:\s*(.+)$/)

    if (!gitdirMatch || !gitdirMatch[1]) {
      throw Error(`Invalid .git file format at ${gitPath}`)
    }

    let gitDir = gitdirMatch[1]

    // Handle relative paths
    if (!path.isAbsolute(gitDir)) {
      gitDir = path.resolve(gitProjectPath, gitDir)
    }

    // For worktrees, the config file is in the main repository's .git directory
    // The worktree gitdir points to .git/worktrees/<name>, so we need to go up
    // to find the main .git/config, or use the commondir file if present
    const commondirPath = path.join(gitDir, 'commondir')
    if (fs.existsSync(commondirPath)) {
      const commondir = fs.readFileSync(commondirPath, 'utf-8').trim()
      const resolvedCommondir = path.isAbsolute(commondir)
        ? commondir
        : path.resolve(gitDir, commondir)
      return path.join(resolvedCommondir, 'config')
    }

    // Fallback: look for config in the worktree's git directory
    return path.join(gitDir, 'config')
  }

  throw Error(`Unexpected .git type at ${gitPath}`)
}

export function parseGitConfig(gitProjectPath: string): { repoRid: string; token: string } {
  try {
    const gitConfigPath = resolveGitConfigPath(gitProjectPath)

    if (!fs.existsSync(gitConfigPath)) {
      throw Error(`Git config file not found at ${gitConfigPath}`)
    }

    const gitConfigContent = fs.readFileSync(gitConfigPath, 'utf-8')

    const urlMatch = gitConfigContent.match(/url\s*=\s*(https:\/\/[^\s]+)/)
    if (!urlMatch || !urlMatch[1]) {
      throw Error('Could not extract URL from git config')
    }

    const gitUrl = urlMatch[1]

    const url = new URL(gitUrl)

    const pathParts = url.pathname.split('/')
    const repoRid = pathParts[3]
    if (!repoRid || !repoRid.startsWith('ri.stemma.')) {
      throw Error(
        `Unexpected code repository RID: ${repoRid}. expecting similar to ri.stemma.*.repository.[UUID]`,
      )
    }

    return {
      repoRid,
      token: url.password,
    }
  } catch (error) {
    throw Error(
      `Failed to parse .git/config. ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Extracts just the token from a Foundry Code Repository git config.
 * Returns undefined if the cwd is not a Foundry git repo.
 */
export function parseGitToken(gitProjectPath: string): string | undefined {
  try {
    return parseGitConfig(gitProjectPath).token || undefined
  } catch {
    return undefined
  }
}
