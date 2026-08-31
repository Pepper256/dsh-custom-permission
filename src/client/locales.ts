/** `custom-permission` namespace dictionaries (the preset-panel copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'button.aria': '权限预设',
  'panel.title': '权限预设',
  'panel.active': '当前',
  'panel.loading': '正在加载预设…',
  'panel.error': '操作失败，请检查并修复 cordis.patch.yml',
  'panel.error.detail': '详情：{detail}',
  'panel.empty': '未配置预设',
  'panel.switchTo': '切换到 {name}',
  'panel.quickAdd': '快捷添加',
  'panel.quickAddHint': '快捷添加即将支持；当前请手动编辑 cordis.patch.yml 新增预设',
  'panel.close': '关闭',
} satisfies Record<string, string>

/** The `custom-permission` namespace key union. */
export type PermissionKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'button.aria': 'Permission presets',
  'panel.title': 'Permission presets',
  'panel.active': 'active',
  'panel.loading': 'Loading presets…',
  'panel.error': 'Operation failed — check and fix cordis.patch.yml',
  'panel.error.detail': 'Detail: {detail}',
  'panel.empty': 'No presets configured',
  'panel.switchTo': 'Switch to {name}',
  'panel.quickAdd': 'Quick add',
  'panel.quickAddHint': 'Quick add is coming soon; add a preset by editing cordis.patch.yml for now',
  'panel.close': 'Close',
} satisfies Record<PermissionKey, string>
