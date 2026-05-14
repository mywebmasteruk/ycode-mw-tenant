/**
 * Frontend API client for the Webflow integration.
 * Mirrors the patterns used in `lib/apps/airtable/client.ts`.
 */

import { ToastError } from '@/lib/toast-error';
import type { WebflowImport, WebflowSite, SyncResult } from './types';

const BASE = '/ycode/api/apps/webflow';
const SETTINGS_BASE = '/ycode/api/apps/webflow/settings';
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json();
  if (body.error) {
    throw body.detail
      ? new ToastError(body.error, body.detail)
      : new Error(body.error);
  }
  return body.data as T;
}

function jsonPost<T>(url: string, payload: unknown): Promise<T> {
  return jsonFetch<T>(url, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

function jsonPut<T>(url: string, payload: unknown): Promise<T> {
  return jsonFetch<T>(url, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export interface WebflowCollectionPreview {
  id: string;
  displayName: string;
  slug: string;
  fieldCount: number;
}

export const webflowApi = {
  getSettings: () => jsonFetch<Record<string, string>>(SETTINGS_BASE),

  saveSettings: (settings: Record<string, string>) =>
    jsonPut<Record<string, string>>(SETTINGS_BASE, settings),

  deleteSettings: () =>
    jsonFetch<void>(SETTINGS_BASE, { method: 'DELETE' }),

  testToken: (apiToken: string) =>
    jsonPost<{ valid: boolean; error?: string }>(`${BASE}/test`, {
      api_token: apiToken,
    }),

  listSites: () => jsonFetch<WebflowSite[]>(`${BASE}/sites`),

  previewCollections: (siteId: string) =>
    jsonFetch<WebflowCollectionPreview[]>(`${BASE}/sites/${siteId}/collections`),

  migrate: (siteId: string) =>
    jsonPost<{ import: WebflowImport; result: SyncResult }>(
      `${BASE}/migrate`,
      { siteId }
    ),

  resync: (importId: string) =>
    jsonPost<SyncResult>(`${BASE}/sync`, { importId }),

  listImports: () => jsonFetch<WebflowImport[]>(`${BASE}/imports`),

  removeImport: (importId: string) =>
    jsonFetch<{ success: boolean }>(`${BASE}/imports/${importId}`, {
      method: 'DELETE',
    }),
};
