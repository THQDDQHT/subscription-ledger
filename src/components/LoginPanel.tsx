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
      <p className="muted">数据保存在服务端，不会上传到第三方。</p>
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
          {busy ? '保存中…' : '登录'}
        </button>
      </form>
    </section>
  );
}
