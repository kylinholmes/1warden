/**
 * 原生窗口自动输入（spec §7.4）的调用口。
 *
 * ## 为什么是「发送按键」而不是「读取字段再填」
 *
 * 原生控件没有 HTML 里 `autocomplete="username"` 的等价物，区分用户名框和
 * 密码框只能靠猜 —— 那是最贵、最不可靠、隐私叙事也最难讲的一块。而合成按键
 * 不需要读任何东西，只要目标应用接受键盘输入就行。
 *
 * ## 措辞上的硬要求
 *
 * 合成按键之后**我们看不到目标控件**，也就无法验证到底填进去没有。
 * 所以界面上一律说「按键已发送」，**绝不**说「已填充」——
 * 一个声称填充成功而实际没填的密码管理器，比一个响亮失败的更糟。
 * 这里导出 `AUTOTYPE_SUCCESS_NOTE` 就是为了让那句话只有一处定义。
 */
import { invoke } from '@tauri-apps/api/core';

export type PermissionState = 'granted' | 'denied';

export interface AutotypeStatus {
  permission: PermissionState;
  enabled: boolean;
  /** 全局快捷键的可读写法（如 `⇧⌘\`） */
  shortcut: string;
}

/** 成功后给用户看的话。刻意不写「已填充」——见文件头的说明。 */
export const AUTOTYPE_SUCCESS_NOTE = '按键已发送。请在目标窗口确认结果。';

export function autotypeStatus(): Promise<AutotypeStatus> {
  return invoke<AutotypeStatus>('autotype_status');
}

export function autotypeSetEnabled(on: boolean): Promise<void> {
  return invoke<void>('autotype_set_enabled', { on });
}

/**
 * 打开系统设置的辅助功能页。
 *
 * 不用系统弹窗引导：macOS 26 上那个框可能根本不出现，
 * 用户点了按钮却什么都没发生 —— 不如明确告诉他去哪儿手动开。
 */
export function autotypeOpenSettings(): Promise<void> {
  return invoke<void>('autotype_open_settings');
}

/**
 * 把凭据敲进**当前焦点所在的**应用。
 *
 * ⚠️ 调用之前必须让本应用失去焦点，否则按键会敲进我们自己的窗口。
 * 调用方负责这一步（见 `AutotypeAction`）。
 */
export function autotypeType(params: {
  username: string | null;
  password: string;
  submit?: boolean;
}): Promise<void> {
  return invoke<void>('autotype_type', {
    username: params.username,
    password: params.password,
    submit: params.submit ?? false,
  });
}
