'use client';

import { useRef, useState } from 'react';
import { Download, LogOut, Upload, X } from 'lucide-react';
import { useLedger } from './ledger-context';
import { fileSize, friendlyDate } from '@/lib/format';
import { api } from '@/lib/api';
import type { Backup } from '@/lib/types';
import { ThemePicker } from './shell';

interface ImportPreview {
  name: string;
  size: number;
  summary?: string;
  error?: string;
  backup?: Backup;
}

function lastExportText(): string {
  let last = '';
  try {
    last = localStorage.getItem('ledger-last-export') || '';
  } catch {
    // 私密模式等无法读取时只影响“上次导出”显示
  }
  const d = last ? new Date(last) : null;
  if (!d || Number.isNaN(d.getTime())) return '尚未在此浏览器导出';
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${friendlyDate(iso, iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function BackupView() {
  const { items, today, confirm, load, reportOk, reportError, logout } = useLedger();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [restoreStatus, setRestoreStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [lastExport, setLastExport] = useState(lastExportText);

  const inspectFile = async (file: File | undefined) => {
    setRestoreStatus(null);
    if (!file) {
      setPreview(null);
      return;
    }
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MiB');
      let backup: Backup;
      try {
        backup = JSON.parse(await file.text()) as Backup;
      } catch {
        throw new Error('不是有效的 JSON 文件');
      }
      if (!backup || backup.format !== 'subscription-ledger' || backup.version !== 1 || !Array.isArray(backup.items)) {
        throw new Error('不是本应用导出的备份（需要 format=subscription-ledger、version=1）');
      }
      const historyCount = Array.isArray(backup.renewals) ? backup.renewals.length : 0;
      setPreview({ name: file.name, size: file.size, summary: `${backup.items.length} 条订阅 · ${historyCount} 条续费历史 · ${fileSize(file.size)}`, backup });
    } catch (error) {
      setPreview({ name: file.name, size: file.size, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const clearImport = () => {
    setPreview(null);
    setRestoreStatus(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const doExport = async () => {
    try {
      const backup = await api<Backup>('/api/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `订阅账本-${today}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      try {
        localStorage.setItem('ledger-last-export', new Date().toISOString());
      } catch {
        // 无法持久化时只影响“上次导出”显示
      }
      setLastExport(lastExportText());
      reportOk('已导出备份 JSON。');
    } catch (error) {
      reportError(error);
    }
  };

  const doRestore = async () => {
    if (!preview?.backup) {
      setRestoreStatus({ text: '请先选择备份文件', error: true });
      return;
    }
    const backup = preview.backup;
    const ok = await confirm({
      title: '覆盖并恢复备份？',
      body: `当前 ${items.length} 条订阅及全部续费历史将被「${preview.name}」中的 ${backup.items.length} 条记录替换。`,
      note: '服务器会先备份现有数据库，恢复后的旧库文件名会显示在这里。',
      accept: '覆盖并恢复',
    });
    if (!ok) return;
    setRestoring(true);
    setRestoreStatus({ text: '正在恢复…', error: false });
    try {
      const result = await api<{ backup_file: string }>('/api/restore', 'POST', { confirm: true, backup });
      clearImport();
      await load();
      setRestoreStatus({ text: `恢复完成，旧数据库已备份为 ${result.backup_file}`, error: false });
    } catch (error) {
      setRestoreStatus({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <section id="backup-page" className="backup">
      <div className="backup-grid">
        <article className="backup-card" aria-labelledby="export-title">
          <div className="backup-card-head">
            <h2 id="export-title">导出备份</h2>
          </div>
          <p className="muted">生成一份 JSON 文件，包含全部订阅与续费历史，不含登录密码。文件里有你的私人备注，请妥善保存。</p>
          <dl className="backup-facts">
            <dt>内容</dt>
            <dd id="export-count">{items.length} 条订阅，含全部续费历史</dd>
            <dt>文件名</dt>
            <dd id="export-name">{today ? `订阅账本-${today}.json` : '—'}</dd>
            <dt>上次导出</dt>
            <dd id="export-last">{lastExport}</dd>
          </dl>
          <div className="backup-card-foot">
            <button id="export" onClick={() => void doExport()}>
              <Download aria-hidden="true" />
              导出 JSON
            </button>
          </div>
        </article>
        <article className="backup-card" aria-labelledby="restore-title">
          <div className="backup-card-head">
            <h2 id="restore-title">恢复备份</h2>
            <span className="backup-tag">覆盖操作</span>
          </div>
          <p className="muted">用一份导出的 JSON 覆盖当前全部记录。恢复前服务器会先备份旧数据库，完成后在这里显示备份文件名。</p>
          <label
            className={`dropzone${dragOver ? ' is-over' : ''}`}
            id="dropzone"
            onDragEnter={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const files = e.dataTransfer?.files;
              if (!files?.length) return;
              if (fileRef.current) fileRef.current.files = files;
              void inspectFile(files[0]);
            }}
          >
            <input
              ref={fileRef}
              id="import-file"
              type="file"
              accept=".json,application/json"
              className="sr-only"
              onChange={(e) => void inspectFile(e.target.files?.[0])}
            />
            <Upload className="dropzone-icon" aria-hidden="true" />
            <span className="dropzone-title">拖入或点击选择备份 JSON</span>
            <span className="dropzone-hint">仅接受本应用导出的文件，最大 2 MiB</span>
          </label>
          {preview && (
            <div id="import-summary" className={`import-summary${preview.error ? ' error' : ''}`}>
              <div className="import-copy">
                <b>{preview.name}</b>
                <small>{preview.error ?? preview.summary}</small>
              </div>
              <button type="button" className="icon-btn" aria-label="移除所选文件" onClick={clearImport}>
                <X aria-hidden="true" />
              </button>
            </div>
          )}
          {restoreStatus && (
            <p id="restore-status" role="status" className={restoreStatus.error ? 'error' : ''}>
              {restoreStatus.text}
            </p>
          )}
          <div className="backup-card-foot">
            <button id="restore" className="danger" disabled={!preview?.backup || restoring} onClick={() => void doRestore()}>
              <Upload aria-hidden="true" />
              校验并恢复备份
            </button>
          </div>
        </article>
      </div>
      <p className="backup-note muted">本应用不会自动扣款、取消订阅或发送主动提醒。取消请前往对应服务操作，再更新这里的状态。</p>
      <div className="mobile-account">
        <ThemePicker mobile />
        <button id="logout-mobile" className="ghost" onClick={() => void logout()}>
          <LogOut aria-hidden="true" />
          退出登录
        </button>
      </div>
    </section>
  );
}
