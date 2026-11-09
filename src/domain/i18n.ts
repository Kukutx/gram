export type Language = 'zh' | 'en';

const translations = {
  zh: {
    ticketHelp:
      '反馈状态：/my_feedbacks\n管理员回复导出：/export_my_replies\n管理员处理：/ticket /assign /reply /resolve /close /reopen\n投递处理：/deliveries /delivery',
    exportReplies: '管理员给你的回复可另行导出：/export_my_replies',
    alreadyHandled: '该请求已处理或已被后续操作替代，请查看当前状态。',
    rateLimited: '操作较频繁，请稍后重试。隐私查询、导出和删除仍可使用。',
    feedbackTextOnly: '当前反馈仅支持文字，请发送文字，或使用 /cancel 取消。',
    privacyCopies:
      '删除作用于当前数据库中的账户、反馈和回复。管理员已收到的消息、Telegram 中的导出文件和备份不会自动撤回；日志不应包含正文。备份按运营策略到期，恢复备份后应重新执行已登记的删除请求。防重元数据不含消息正文或 Telegram 身份，七天后由维护任务批量清理；任务停机时可能延迟。保留期清理为定期批处理，可能有短暂延迟。',
    privacyContact: '隐私和数据请求联系：{contact}',
    ticketMissing: '反馈不存在，或已删除。',
    ticketUpdated: '反馈状态已更新。',
    ticketClosed: '反馈已结案，请先使用 /reopen 重新打开。',
    replyUsage: '使用 /reply <反馈ID> <回复文字>，最多 2000 字符。',
    replyQueued: '回复已保存并排队，送达状态请使用 /ticket 查询。',
    deliveryResult: '投递操作结果：{result}（busy 表示正在投递，稍后重试）',
    welcome: '你好！这是一个基于 grammY 的 Telegram 机器人。\n使用 /help 查看可用命令。',
    help: '可用命令：\n/start 开始\n/help 帮助\n/settings 切换语言\n/feedback 发送反馈\n/cancel 取消反馈\n/id 显示 ID\n/ping 检查机器人\n/privacy 隐私说明\n/my_data 查看我的数据\n/export_my_data 导出个人数据\n/delete_my_data 删除个人数据\n\n管理员：/stats /status /feedbacks',
    settings: '选择语言：',
    languageSaved: '语言已设置为中文。',
    feedbackAsk: '请在 15 分钟内发送一条反馈消息（最多 2000 字符），发送 /cancel 取消。',
    feedbackSaved: '反馈已保存，谢谢！',
    feedbackExpired: '反馈已过期。请重新发送 /feedback。',
    feedbackEmpty: '反馈内容不能为空，请重新发送。',
    feedbackTooLong: '反馈不能超过 2000 字符，请精简后重发。',
    feedbackCommand: '你仍在反馈模式。发送文字或使用 /cancel 取消。',
    canceled: '已取消反馈输入。',
    nothingToCancel: '当前没有待取消的反馈。',
    unknown: '请选择 /help 查看可用命令。',
    privateOnly: '请在与机器人的私聊中使用此功能。',
    forbidden: '无权执行此命令。',
    privacy:
      '此机器人保存你主动提供的 Telegram ID、用户名、名字、语言设置和反馈内容。不会收集你的所有聊天记录。数据用于运行此机器人；你可以在私聊发送 /export_my_data 导出、或使用 /delete_my_data 删除这些数据。管理员能查看反馈。',
    deleted: '你的用户记录和反馈已删除。',
    deleteConfirmPrompt: '确定要永久删除你的用户记录和全部反馈吗？此操作无法撤销。',
    deleteConfirmYes: '确认删除',
    deleteConfirmCancel: '取消',
    deleteCanceled: '已取消删除。',
    deleteInvalidConfirmation: '确认已失效，请重新使用 /delete_my_data。',
    exportNoData: '当前没有可导出的个人数据。',
    exportInvalidCursor: '分页参数无效。发送 /export_my_data 从第一页重新开始。',
    exportNext: '本页已导出。复制以下命令继续导出下一页：\n{command}',
    exportDone: '个人数据已导出完成。请妥善保管收到的 JSON 文件。',
    myData:
      'Telegram ID：{userId}\n已保存反馈：{feedbackCount} 条\n首次使用：{createdAt}\n最后活动：{lastSeenAt}\n语言：{language}\n删除数据：/delete_my_data',
    retentionEnabled: '反馈自动保留期限：{days} 天。超过期限的反馈会被删除（包括待通知反馈）。',
    retentionDisabled: '反馈自动删除：未启用。你可随时使用 /delete_my_data。',
    ping: 'pong ✅',
    id: '你的 ID：{userId}\n当前聊天 ID：{chatId}',
    stats: '用户总数：{users}\n反馈总数：{feedback}\n未通知反馈：{pending}',
    feedbackListEmpty: '目前还没有反馈。',
    feedbackListTitle: '最近的反馈：',
    status:
      '通知积压：{pending} 条\n积压等级：{health}\n最老待通知：{oldestSeconds} 秒\n队列状态：{queue}',
  },
  en: {
    ticketHelp:
      'Feedback status: /my_feedbacks\nExport admin replies: /export_my_replies\nAdmin workflow: /ticket /assign /reply /resolve /close /reopen\nDelivery controls: /deliveries /delivery',
    exportReplies: 'Export replies from the administrator separately: /export_my_replies',
    alreadyHandled: 'This request was processed or superseded. Check the current state.',
    rateLimited:
      'Too many requests. Please try again shortly. Privacy, export and deletion remain available.',
    feedbackTextOnly: 'Please send text for this feedback, or /cancel.',
    privacyCopies:
      'Deletion removes the account, feedback and replies from the current database. Messages already sent to admins, Telegram export files and backups are not automatically recalled. Logs must not contain message bodies. Backup copies expire under the operator policy; registered erasure requests must be reapplied after restore. Replay metadata contains no message text or Telegram identity and is batch-cleaned after seven days; maintenance outages can delay cleanup. Retention runs in batches and may be delayed.',
    privacyContact: 'Privacy and data requests: {contact}',
    ticketMissing: 'Feedback does not exist or was erased.',
    ticketUpdated: 'Feedback updated.',
    ticketClosed: 'Feedback is closed. Use /reopen first.',
    replyUsage: 'Use /reply <feedbackId> <text>, up to 2000 characters.',
    replyQueued: 'Reply saved and queued. Check delivery with /ticket.',
    deliveryResult: 'Delivery action: {result} (busy means a send is in progress; retry later).',
    welcome: 'Hello! This is a Telegram bot powered by grammY.\nUse /help to see commands.',
    help: 'Commands:\n/start Start\n/help Help\n/settings Change language\n/feedback Send feedback\n/cancel Cancel feedback\n/id Show IDs\n/ping Check bot\n/privacy Privacy notice\n/my_data View stored data\n/export_my_data Export your data\n/delete_my_data Delete your data\n\nAdmin: /stats /status /feedbacks',
    settings: 'Choose a language:',
    languageSaved: 'Language changed to English.',
    feedbackAsk:
      'Send one feedback message within 15 minutes (max 2000 characters). Send /cancel to stop.',
    feedbackSaved: 'Feedback saved. Thank you!',
    feedbackExpired: 'Feedback expired. Send /feedback to start again.',
    feedbackEmpty: 'Feedback cannot be empty. Please send text.',
    feedbackTooLong: 'Feedback exceeds 2000 characters. Please shorten it.',
    feedbackCommand: 'Feedback is still pending. Send text or /cancel.',
    canceled: 'Feedback input canceled.',
    nothingToCancel: 'There is no pending feedback to cancel.',
    unknown: 'Use /help to see the available commands.',
    privateOnly: 'Please use this command in a private chat with the bot.',
    forbidden: 'You are not authorized to use this command.',
    privacy:
      'This bot stores your Telegram ID, username, first name, language preference, and any feedback you submit. It does not store all your chat history. Data is used to operate this bot and admins can review feedback. Use /export_my_data to export your stored data or /delete_my_data in private chat to erase it.',
    deleted: 'Your account record and feedback have been deleted.',
    deleteConfirmPrompt:
      'Permanently delete your account record and all feedback? This cannot be undone.',
    deleteConfirmYes: 'Delete my data',
    deleteConfirmCancel: 'Cancel',
    deleteCanceled: 'Deletion canceled.',
    deleteInvalidConfirmation: 'Confirmation expired or invalid. Send /delete_my_data again.',
    exportNoData: 'No stored personal data was found.',
    exportInvalidCursor: 'Invalid page cursor. Send /export_my_data to start again.',
    exportNext: 'This page was exported. Copy this command for the next page:\n{command}',
    exportDone: 'Your data export is complete. Store the JSON file securely.',
    myData:
      'Telegram ID: {userId}\nSaved feedback: {feedbackCount}\nFirst seen: {createdAt}\nLast active: {lastSeenAt}\nLanguage: {language}\nDelete data: /delete_my_data',
    retentionEnabled:
      'Automatic feedback retention: {days} days. Older feedback will be removed, including undelivered notices.',
    retentionDisabled: 'Automatic feedback deletion: disabled. You can use /delete_my_data at any time.',
    ping: 'pong ✅',
    id: 'Your ID: {userId}\nCurrent chat ID: {chatId}',
    stats: 'Users: {users}\nFeedback: {feedback}\nNot yet notified: {pending}',
    feedbackListEmpty: 'There is no feedback yet.',
    feedbackListTitle: 'Recent feedback:',
    status:
      'Pending notices: {pending}\nBacklog severity: {health}\nOldest pending: {oldestSeconds} seconds\nQueue: {queue}',
  },
} satisfies Record<Language, Record<string, string>>;

export type TranslationKey = keyof (typeof translations)['zh'];

export function normalizeLanguage(code: string | undefined | null): Language {
  return code?.toLowerCase().startsWith('en') ? 'en' : 'zh';
}

export function t(
  language: Language,
  key: TranslationKey,
  variables: Record<string, string | number> = {},
): string {
  return translations[language][key].replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) =>
    Object.hasOwn(variables, name) ? String(variables[name]) : whole,
  );
}
