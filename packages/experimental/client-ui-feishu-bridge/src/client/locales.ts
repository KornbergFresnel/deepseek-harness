/** `feishu.bridge` dictionaries for the Session header Feishu chip. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'feishu.bridge'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'connect': '连接飞书',
  'hint': '把这个会话连接到飞书聊天',
  'connected': '已连接飞书聊天：{name}',
  'chats': '飞书聊天',
  'direct': '私聊',
  'unnamed': '未命名群聊',
  'inUse': '正在使用其他会话',
  'noChats': '先在飞书里给机器人发一条消息',
  'disconnect': '断开飞书',
  'unavailable': '飞书不可用',
  'failed': '飞书操作失败：{reason}',
}

/** Dictionary key union shared by every locale. */
export type FeishuBridgeKey = keyof typeof zh

/** English dictionary. */
export const en: Record<FeishuBridgeKey, string> = {
  'connect': 'Connect Feishu',
  'hint': 'Connect this Session to a Feishu chat',
  'connected': 'Connected to Feishu chat: {name}',
  'chats': 'Feishu chats',
  'direct': 'Direct chat',
  'unnamed': 'Unnamed group',
  'inUse': 'used by another Session',
  'noChats': 'Send the bot a message in Feishu first',
  'disconnect': 'Disconnect Feishu',
  'unavailable': 'Feishu unavailable',
  'failed': 'Feishu action failed: {reason}',
}
