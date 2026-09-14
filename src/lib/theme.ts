/** 外观：跟随系统 / 浅色 / 深色。偏好存 localStorage('ledger-theme')，首帧前由 layout 内联脚本写入。 */
export type ThemeMode = 'system' | 'light' | 'dark';

export function currentTheme(): ThemeMode {
  if (typeof document === 'undefined') return 'system';
  const attr = document.documentElement.dataset.theme;
  return attr === 'light' || attr === 'dark' ? attr : 'system';
}

export function applyTheme(mode: ThemeMode, animate: boolean): void {
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-transition');
    setTimeout(() => root.classList.remove('theme-transition'), 320);
  }
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
  else delete root.dataset.theme;
  try {
    if (mode === 'system') localStorage.removeItem('ledger-theme');
    else localStorage.setItem('ledger-theme', mode);
  } catch {
    // 私密模式等无法持久化时仍即时生效
  }
}

/** layout.tsx 内联脚本的内容（首帧前执行，防闪烁）。 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('ledger-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}})()`;
