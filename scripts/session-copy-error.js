'use strict';
const { AMBIGUOUS_SESSION_ACCOUNT } = require('./account-identity');
// Allowlisted explanations only: arbitrary exception text may contain SQL rows,
// auth material or user input. Never send that text to the UI or task log.
function sanitizeSessionCopyError(error) {
  if (error && error.code === 'WBS_AMBIGUOUS_SESSION_ACCOUNT') return AMBIGUOUS_SESSION_ACCOUNT;
  const text = String(error && (error.code || error.message) || error || '');
  if (/SQLITE_BUSY|SQLITE_LOCKED/i.test(text)) return '会话数据库正被占用，请稍后重新同步';
  if (/EACCES|EPERM/i.test(text)) return '没有读取或写入会话文件的权限，请检查文件权限后重新同步';
  if (/ENOENT/i.test(text)) return '会话数据库或文件不存在，请确认 WorkBuddy 已正常启动后重新同步';
  if (/ENOSPC/i.test(text)) return '磁盘空间不足，请释放空间后重新同步';
  if (/SQLITE_CORRUPT|SQLITE_NOTADB/i.test(text)) return '会话数据库无法读取，请先检查 WorkBuddy 是否能正常打开会话';
  if (/SQLITE_ERROR/i.test(text)) return '会话数据库结构不兼容，请更新 WorkDaddy 后重新同步';
  return '同步任务异常中断，请稍后重新同步；若仍失败，请反馈客户端版本及同步阶段';
}
module.exports = { sanitizeSessionCopyError };
