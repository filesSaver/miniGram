import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';

const BASE = '/api';

@Injectable({ providedIn: 'root' })
export class AuthService {
  // ── In-memory caches ──────────────────────────────────────────────────────
  private _groupsCache: { groups: Group[]; total: number; groupCount: number; channelCount: number } | null = null;
  private _groupCache   = new Map<string, Group>();
  private _topicsCache  = new Map<string, Topic[]>();
  private _breakdownCache = new Map<string, GroupBreakdown>();
  // key = groupId:topicId for topic breakdowns
  private _topicBreakdownCache = new Map<string, GroupBreakdown>();
  // Message items cache: key = groupId  OR  groupId:topicId
  private _itemsCache   = new Map<string, ContentItem[]>();

  constructor(private http: HttpClient) {}

  // ── Auth ──────────────────────────────────────────────────────────────────
  checkStatus(): Observable<{ authorized: boolean }> {
    return this.http.get<{ authorized: boolean }>(`${BASE}/auth/status`);
  }
  sendCode(phoneNumber: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${BASE}/auth/send-code`, { phoneNumber });
  }
  signIn(phoneNumber: string, code: string): Observable<any> {
    return this.http.post<any>(`${BASE}/auth/sign-in`, { phoneNumber, code });
  }
  submit2FA(password: string): Observable<any> {
    return this.http.post<any>(`${BASE}/auth/2fa`, { password });
  }

  // ── Download ──────────────────────────────────────────────────────────────
  download(url: string): Observable<any> {
    return this.http.post<any>(`${BASE}/download`, { url });
  }
  downloadBatch(groupId: string, groupName: string, messageIds: string[], destKey: string): Observable<{ jobId: string; status: string; total: number }> {
    return this.http.post<{ jobId: string; status: string; total: number }>(`${BASE}/download/batch`, { groupId, groupName, messageIds, destKey });
  }
  getDownloadStatus(jobId: string): Observable<DownloadJob> {
    return this.http.get<DownloadJob>(`${BASE}/download/status/${jobId}`);
  }
  getDownloadLocations(): Observable<{ desktop: string; downloads: string; custom: string }> {
    return this.http.get<{ desktop: string; downloads: string; custom: string }>(`${BASE}/download/locations`);
  }
  getDownloadCounts(): Observable<Record<string, number>> {
    return this.http.get<Record<string, number>>(`${BASE}/download/counts`);
  }
  getDownloadLog(destKey: string, groupFolder: string): Observable<DownloadLog> {
    return this.http.get<DownloadLog>(`${BASE}/download/log/${destKey}/${encodeURIComponent(groupFolder)}`);
  }
  openPath(filePath: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${BASE}/download/open`, { filePath });
  }

  // ── Groups ────────────────────────────────────────────────────────────────
  getGroups(limit = 10, offset = 0): Observable<{ groups: Group[]; total: number; groupCount: number; channelCount: number; offset: number; limit: number }> {
    if (this._groupsCache) return of({ ...this._groupsCache, offset, limit });
    return this.http.get<{ groups: Group[]; total: number; groupCount: number; channelCount: number; offset: number; limit: number }>(
      `${BASE}/groups?limit=${limit}&offset=${offset}`
    ).pipe(tap(res => {
      this._groupsCache = { groups: res.groups, total: res.total, groupCount: res.groupCount, channelCount: res.channelCount };
      res.groups.forEach(g => this._groupCache.set(g.id, g));
    }));
  }

  getGroup(groupId: string): Observable<Group> {
    const cached = this._groupCache.get(groupId);
    if (cached) return of(cached);
    return this.http.get<Group>(`${BASE}/groups/${groupId}`).pipe(
      tap(g => this._groupCache.set(groupId, g))
    );
  }

  getGroupContent(groupId: string, type = 'all', limit = 10, offset = 0): Observable<{ items: ContentItem[]; total: number; offset: number; limit: number }> {
    const key = groupId;
    const cached = this._itemsCache.get(key);
    if (cached) {
      const filtered = type === 'all' ? cached : cached.filter(i => i.type === type);
      return of({ items: filtered, total: filtered.length, offset, limit });
    }
    return this.http.get<{ items: ContentItem[]; total: number; offset: number; limit: number }>(
      `${BASE}/groups/${groupId}/content?type=all&limit=${limit}&offset=${offset}`
    ).pipe(tap(res => this._itemsCache.set(key, res.items)));
  }

  // ── Topics ────────────────────────────────────────────────────────────────
  getTopics(groupId: string): Observable<{ topics: Topic[] }> {
    const cached = this._topicsCache.get(groupId);
    if (cached) return of({ topics: cached });
    return this.http.get<{ topics: Topic[] }>(`${BASE}/groups/${groupId}/topics`).pipe(
      tap(res => this._topicsCache.set(groupId, res.topics))
    );
  }

  getTopicContent(groupId: string, topicId: number, type = 'all'): Observable<{ items: ContentItem[]; total: number }> {
    const key = `${groupId}:${topicId}`;
    const cached = this._itemsCache.get(key);
    if (cached) {
      const filtered = type === 'all' ? cached : cached.filter(i => i.type === type);
      return of({ items: filtered, total: filtered.length });
    }
    return this.http.get<{ items: ContentItem[]; total: number }>(
      `${BASE}/groups/${groupId}/topics/${topicId}/content?type=all`
    ).pipe(tap(res => this._itemsCache.set(key, res.items)));
  }

  getContentRange(groupId: string, from: number, to: number): Observable<{ items: ContentItem[]; total: number }> {
    return this.http.get<{ items: ContentItem[]; total: number }>(
      `${BASE}/groups/${groupId}/content/range?from=${from}&to=${to}`
    );
  }

  getTopicContentRange(groupId: string, topicId: number, from: number, to: number): Observable<{ items: ContentItem[]; total: number }> {
    return this.http.get<{ items: ContentItem[]; total: number }>(
      `${BASE}/groups/${groupId}/topics/${topicId}/content/range?from=${from}&to=${to}`
    );
  }

  streamTopicBreakdown(groupId: string, topicId: number): EventSource {
    return new EventSource(`/api/groups/${groupId}/topics/${topicId}/breakdown/stream`);
  }

  // ── Stats / Breakdown ─────────────────────────────────────────────────────
  getGroupStats(groupId: string): Observable<GroupStats> {
    return this.http.get<GroupStats>(`${BASE}/groups/${groupId}/stats`);
  }

  getGroupBreakdown(groupId: string): Observable<GroupBreakdown> {
    const cached = this._breakdownCache.get(groupId);
    if (cached) return of(cached);
    return this.http.get<GroupBreakdown>(`${BASE}/groups/${groupId}/breakdown`).pipe(
      tap(bd => this._breakdownCache.set(groupId, bd))
    );
  }

  streamGroupBreakdown(groupId: string): EventSource {
    return new EventSource(`/api/groups/${groupId}/breakdown/stream`);
  }

  // ── Cache helpers (call after a fresh download to bust stale counts) ──────
  bustGroupsCache() { this._groupsCache = null; }
  bustItemsCache(key: string) { this._itemsCache.delete(key); }
  hasItemsCache(key: string): boolean { return this._itemsCache.has(key); }
  hasBreakdownCache(groupId: string): boolean { return this._breakdownCache.has(groupId); }
  setBreakdownCache(groupId: string, bd: GroupBreakdown) { this._breakdownCache.set(groupId, bd); }
  hasTopicsCache(groupId: string): boolean { return this._topicsCache.has(groupId); }
  hasTopicBreakdownCache(key: string): boolean { return this._topicBreakdownCache.has(key); }
  getTopicBreakdownCache(key: string): GroupBreakdown | undefined { return this._topicBreakdownCache.get(key); }
  setTopicBreakdownCache(key: string, bd: GroupBreakdown) { this._topicBreakdownCache.set(key, bd); }
}

export interface Group {
  id: string;
  name: string;
  type: 'group' | 'channel';
  memberCount: number | null;
  adminCount: number | null;
  createdAt: string | null;
  username: string | null;
  about: string | null;
  scam: boolean;
  fake: boolean;
  restricted: boolean;
  verified: boolean;
  broadcast: boolean;
  megagroup: boolean;
  gigagroup: boolean;
  forum: boolean;
  hasLink: boolean;
  hasGeo: boolean;
  slowmodeEnabled: boolean;
  noforwards: boolean;
  joinToSend: boolean;
  joinRequest: boolean;
}

export interface Topic {
  id: number;
  title: string;
  topMessage: number;
  unreadCount: number;
  closed: boolean;
  pinned: boolean;
  iconEmoji: string | null;
}

export interface GroupStats {
  total: number;
}

export interface GroupBreakdown {
  video: number;
  audio: number;
  image: number;
  pdf: number;
  chat: number;
  other: number;
}

export interface ContentItem {
  id: string;
  type: 'video' | 'image' | 'pdf' | 'chat' | 'other';
  text: string;
  date: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
}

export interface DownloadJob {
  jobId: string;
  status: 'running' | 'done' | 'failed';
  total: number;
  done: number;
  downloaded: number;
  folder: string | null;
  results: DownloadResult[];
  itemStatus: Record<string, ItemDownloadStatus>;
  itemProgress: Record<string, ItemProgress>;
  error: string | null;
}

export type ItemDownloadStatus = 'queued' | 'downloading' | 'done' | 'error' | 'skipped' | 'idle';

export interface ItemProgress {
  pct: number;
  downloaded: number;
  total: number;
}

export interface DownloadResult {
  messageId: string;
  status: string;
  fileName?: string;
  filePath?: string;
  reason?: string;
  skippedAlreadyDone?: boolean;
}

export interface DownloadLogEntry {
  status: 'done' | 'error' | 'skipped';
  fileName?: string;
  filePath?: string;
  fileSize?: number;
  reason?: string;
  ts: number;
}

export type DownloadLog = Record<string, DownloadLogEntry>;
