/** `git.branch` dictionaries for the New Session branch chip. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'git.branch'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'hint': '切换 Git 分支',
  'detached': '分离于 {commit}',
  'local': '本地分支',
  'remote': '远程分支',
  'truncated': '只列出最近提交的分支',
  'noBranches': '没有可切换的分支',
  'unavailable': '无法读取分支',
  'switchFailed': '无法切换到 {branch}：{reason}',
}

/** Dictionary key union shared by every locale. */
export type GitBranchKey = keyof typeof zh

/** English dictionary. */
export const en: Record<GitBranchKey, string> = {
  'hint': 'Switch Git branch',
  'detached': 'Detached at {commit}',
  'local': 'Local branches',
  'remote': 'Remote branches',
  'truncated': 'Only the most recently committed branches are listed',
  'noBranches': 'No branches to switch to',
  'unavailable': 'Branch unavailable',
  'switchFailed': 'Could not switch to {branch}: {reason}',
}
