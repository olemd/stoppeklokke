// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Full data export/import in the browser (§9.1): pages through every
 * collection and assembles one JSON file; import validates the file
 * (format, version → upgrade), then sends ≤ 500 rows per request in
 * dependency order and verifies row counts at the end.
 */
import { useState } from 'preact/hooks';
import type { ExportDoc } from '../../core/export/format';
import { ApiError, get, post } from '../lib/api';
import { t } from '../lib/i18n';
import { loadAll } from '../lib/store';
import { showError, toast } from './Toast';

interface Page {
  format: 'stoppeklokke';
  version: number;
  app_version: string;
  collections: string[];
  rows?: Record<string, unknown>[];
  next?: string | null;
}

export function DataSettings() {
  const [progress, setProgress] = useState('');
  const [canWipe, setCanWipe] = useState(false);
  const [busy, setBusy] = useState(false);

  const doExport = async () => {
    setBusy(true);
    try {
      const meta = await get<Page>('/export');
      const data: Record<string, unknown[]> = {};
      let total = 0;
      for (const name of meta.collections) {
        data[name] = [];
        let cursor: string | null | undefined = null;
        do {
          const page: Page = await get<Page>(
            `/export?collection=${name}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          );
          data[name]!.push(...(page.rows ?? []));
          total += page.rows?.length ?? 0;
          cursor = page.next;
          setProgress(t('data.exporting', { collection: name, count: data[name]!.length }));
        } while (cursor);
      }
      const doc = {
        format: meta.format,
        version: meta.version,
        exported_at: Math.floor(Date.now() / 1000),
        app_version: meta.app_version,
        data,
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(doc)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `stoppeklokke-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast(t('data.exported', { count: total }));
    } catch (err) {
      showError(err);
    } finally {
      setProgress('');
      setBusy(false);
    }
  };

  const doImport = async (file: File) => {
    // Loaded on demand: validation pulls in zod, which the rest of the app does not need.
    const { ExportDoc: Schema, MAX_PAGE, upgrade } = await import('../../core/export/format');
    let doc: ExportDoc;
    try {
      doc = upgrade(Schema.parse(JSON.parse(await file.text())));
    } catch (err) {
      toast(t('data.invalidFile', { message: (err as Error).message.slice(0, 200) }), {
        kind: 'error',
      });
      return;
    }
    setBusy(true);
    try {
      const { collections } = await post<{ collections: string[] }>('/import/begin');
      setCanWipe(true);
      const counts: Record<string, number> = {};
      for (const name of collections) {
        const rows = doc.data[name] ?? [];
        counts[name] = rows.length;
        for (let i = 0; i < rows.length; i += MAX_PAGE) {
          setProgress(t('data.importing', { collection: name, done: i, total: rows.length }));
          await post('/import', { collection: name, rows: rows.slice(i, i + MAX_PAGE) });
        }
      }
      await post('/import/finish', { counts });
      setCanWipe(false);
      toast(t('data.imported'));
      await loadAll();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      toast(t('data.failed', { message }), { kind: 'error', ms: 15_000 });
    } finally {
      setProgress('');
      setBusy(false);
    }
  };

  return (
    <section class="panel stack" aria-labelledby="s-data">
      <h2 id="s-data">{t('data.title')}</h2>
      <p class="hint">{t('data.intro')}</p>
      <div class="actions start">
        <button type="button" class="btn plain" disabled={busy} onClick={doExport}>
          {t('data.export')}
        </button>
        <label class={`btn plain file-btn ${busy ? 'is-disabled' : ''}`}>
          {t('data.import')}
          <input
            type="file"
            accept="application/json,.json"
            class="visually-hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (f) void doImport(f);
            }}
          />
        </label>
      </div>
      <p class="hint">{t('data.importHint')}</p>
      {progress && (
        <p role="status" aria-live="polite">
          {progress}
        </p>
      )}
      {canWipe && !busy && (
        <button
          type="button"
          class="btn danger-plain"
          onClick={async () => {
            try {
              await post('/import/wipe');
              setCanWipe(false);
              toast(t('data.wiped'));
              await loadAll();
            } catch (err) {
              showError(err);
            }
          }}
        >
          {t('data.wipe')}
        </button>
      )}
    </section>
  );
}
