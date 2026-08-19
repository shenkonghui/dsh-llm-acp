/** Locale bundles for the ACP Servers settings section. */

/** Locale keys this surface renders. */
export type AcpSettingsLocaleKey =
  | 'nav' | 'title' | 'intro'
  | 'registryTab' | 'serversTab'
  | 'registrySearch' | 'registryEmpty'
  | 'add' | 'adding' | 'added' | 'remove' | 'removeConfirm'
  | 'addFailed' | 'removeFailed'
  | 'noServers' | 'serverCommand' | 'serverArgs' | 'serverName'
  | 'distributionNpx' | 'distributionBinary' | 'distributionUvx'
  | 'version' | 'authors' | 'repository' | 'website'
  | 'edit' | 'collapse' | 'save' | 'saving'
  | 'envVars' | 'envVarsHint' | 'envKey' | 'envValue'
  | 'addEnvVar' | 'noEnvVars'
  | 'modelSelect' | 'modelSelectHint' | 'noModels' | 'modelsLoading'
  | 'selectAll' | 'selectNone'

/** English copy. */
export const en: Record<AcpSettingsLocaleKey, string> = {
  nav: 'ACP Servers',
  title: 'ACP Servers',
  intro: 'Add external ACP agent servers from the registry and manage configured servers.',
  registryTab: 'Registry',
  serversTab: 'My Servers',
  registrySearch: 'Search agents…',
  registryEmpty: 'No agents found.',
  add: 'Add',
  adding: 'Adding…',
  added: 'Added',
  remove: 'Remove',
  removeConfirm: 'Remove this ACP server?',
  addFailed: 'Failed to add the server.',
  removeFailed: 'Failed to remove the server.',
  noServers: 'No ACP servers configured. Browse the registry to add one.',
  serverCommand: 'Command',
  serverArgs: 'Arguments',
  serverName: 'Name',
  distributionNpx: 'npx',
  distributionBinary: 'binary',
  distributionUvx: 'uvx',
  version: 'Version',
  authors: 'Authors',
  repository: 'Repository',
  website: 'Website',
  edit: 'Edit',
  collapse: 'Collapse',
  save: 'Save',
  saving: 'Saving…',
  envVars: 'Environment Variables',
  envVarsHint: 'Set environment variables for authentication (e.g. API keys). These are merged on top of the plugin-level env.',
  envKey: 'Key',
  envValue: 'Value',
  addEnvVar: 'Add variable',
  noEnvVars: 'No environment variables set.',
  modelSelect: 'Enabled Models',
  modelSelectHint: 'Select which models to expose from this server. Leave empty to expose all discovered models.',
  noModels: 'No models discovered yet. The server may still be starting.',
  modelsLoading: 'Loading models…',
  selectAll: 'Select all',
  selectNone: 'Select none',
}

/** Chinese copy. */
export const zh: Record<AcpSettingsLocaleKey, string> = {
  nav: 'ACP 服务',
  title: 'ACP 服务',
  intro: '从注册表添加外部 ACP 代理服务器，管理已配置的服务器。',
  registryTab: '注册表',
  serversTab: '我的服务',
  registrySearch: '搜索代理…',
  registryEmpty: '未找到代理。',
  add: '添加',
  adding: '添加中…',
  added: '已添加',
  remove: '移除',
  removeConfirm: '确定移除此 ACP 服务器？',
  addFailed: '添加服务器失败。',
  removeFailed: '移除服务器失败。',
  noServers: '尚未配置 ACP 服务器。浏览注册表来添加。',
  serverCommand: '命令',
  serverArgs: '参数',
  serverName: '名称',
  distributionNpx: 'npx',
  distributionBinary: '二进制',
  distributionUvx: 'uvx',
  version: '版本',
  authors: '作者',
  repository: '仓库',
  website: '网站',
  edit: '编辑',
  collapse: '收起',
  save: '保存',
  saving: '保存中…',
  envVars: '环境变量',
  envVarsHint: '为 ACP 服务设置环境变量用于认证（如 API Key），会与插件级环境变量合并。',
  envKey: '键名',
  envValue: '键值',
  addEnvVar: '添加变量',
  noEnvVars: '尚未设置环境变量。',
  modelSelect: '启用模型',
  modelSelectHint: '选择要启用的模型，不选则启用全部已发现的模型。',
  noModels: '尚未发现模型，服务可能仍在启动中。',
  modelsLoading: '模型加载中…',
  selectAll: '全选',
  selectNone: '全不选',
}
