import 'dotenv/config';
import { Api } from 'grammy';
import { parseTelegramCliConfig } from '../src/config/env.ts';

async function main() {
  const api = new Api(parseTelegramCliConfig().BOT_TOKEN);
  const english = [
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'Show available commands' },
    { command: 'settings', description: 'Change language' },
    { command: 'feedback', description: 'Send feedback' },
    { command: 'my_feedbacks', description: 'View feedback status' },
    { command: 'cancel', description: 'Cancel feedback' },
    { command: 'ping', description: 'Check status' },
    { command: 'id', description: 'Show Telegram IDs' },
    { command: 'privacy', description: 'Privacy notice' },
    { command: 'my_data', description: 'View your stored data' },
    { command: 'export_my_data', description: 'Export your stored data' },
    { command: 'export_my_replies', description: 'Export replies to your feedback' },
    { command: 'delete_my_data', description: 'Delete your stored data' },
  ];
  const chinese = [
    { command: 'start', description: '开始' },
    { command: 'help', description: '帮助' },
    { command: 'settings', description: '语言设置' },
    { command: 'feedback', description: '提交反馈' },
    { command: 'my_feedbacks', description: '查看反馈处理状态' },
    { command: 'cancel', description: '取消反馈' },
    { command: 'ping', description: '机器人状态' },
    { command: 'id', description: '查看 Telegram ID' },
    { command: 'privacy', description: '隐私说明' },
    { command: 'my_data', description: '查看已保存的数据' },
    { command: 'export_my_data', description: '导出个人数据' },
    { command: 'export_my_replies', description: '导出管理员回复' },
    { command: 'delete_my_data', description: '删除个人数据' },
  ];
  // These two commands require a trusted, configured admin ID at runtime.
  // Telegram's default public command list intentionally excludes them.
  await api.setMyCommands(english);
  await api.setMyCommands(chinese, { language_code: 'zh' });
  console.log('Bot commands synchronized.');
}
main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
