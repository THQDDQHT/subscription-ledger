'use client';

import { useState } from 'react';
import { useLedger } from './ledger-context';
import { BrandMark } from './shell';

export default function LoginPanel() {
  const { login, reportError } = useLedger();
  const [busy, setBusy] = useState(false);

  return (
    <section id="login-panel" className="panel">
      <div className="login-brand">
        <BrandMark />
        <b>订阅账本</b>
      </div>
      <h2>登录私人账本</h2>
      <p className="muted">把订阅与日常账单，整理得井井有条。</p>
      <form
        id="login-form"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const password = new FormData(form).get('password') as string;
          setBusy(true);
          login(password)
            .then(() => form.reset())
            .catch(reportError)
            .finally(() => setBusy(false));
        }}
      >
        <label>
          密码
          <input name="password" type="password" autoComplete="current-password" required maxLength={1024} />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? '登录中…' : '进入我的账本'}
        </button>
      </form>
      <p className="login-note">你的私人工作空间 · 数据保存在服务端</p>
    </section>
  );
}
