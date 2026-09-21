import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { tap, map } from 'rxjs/operators';

const BASE = '/api';
// Downloads must bypass the Angular dev-proxy (which buffers the full response).
// In production BASE_DIRECT === BASE (same origin). Locally it hits the gateway directly.
const BASE_DIRECT = (typeof window !== 'undefined' && window.location.port === '4200')
  ? 'http://localhost:3000'
  : '';
const TOKEN_KEY = 'mg_jwt';
const GROUPS_CACHE_KEY = 'mg_groups_cache';

@Injectable({ providedIn: 'root' })
export class AuthService {
  // ── In-memory caches ──────────────────────────────────────────────────────
  private _groupsCache: { groups: Group[]; total: number; groupCount: number; channelCount: number } | null = null;
  private _groupCache   = new Map<string, Group>();
  private _topicsCache  = new Map<string, Topic[]>();
  private _breakdownCache = new Map<string, GroupBreakdown>();
  private _topicBreakdownCache = new Map<string, GroupBreakdown>();
  private _itemsCache   = new Map<string, ContentItem[]>();

  constructor(private http: HttpClient) {
    // Warm in-memory cache from localStorage on service init
    const stored = localStorage.getItem(GROUPS_CACHE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        this._groupsCache = parsed;
        parsed.groups.forEach((g: Group) => this._groupCache.set(g.id, g));
      } catch {
        localStorage.removeItem(GROUPS_CACHE_KEY);
      }
    }
  }

  // ── JWT helpers ───────────────────────────────────────────────────────────
  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  private setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  }

  clearToken(): void {
    localStorage.removeItem(TOKEN_KEY);
  }

  isLoggedIn(): boolean {
    return !!this.getToken();
  }

  logout(): void {
    this.clearToken();
    this._groupsCache = null;
    this._groupCache.clear();
    this._topicsCache.clear();
    this._breakdownCache.clear();
    this._topicBreakdownCache.clear();
    this._itemsCache.clear();
    this._photoCache.forEach(url => URL.revokeObjectURL(url));
    this._photoCache.clear();
    localStorage.removeItem(GROUPS_CACHE_KEY);
  }

  // ── App-level auth ────────────────────────────────────────────────────────
  register(username: string, password: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${BASE}/auth/register`, { username, password });
  }

  appLogin(username: string, password: string): Observable<{ token: string; username: string }> {
    return this.http.post<{ token: string; username: string }>(`${BASE}/auth/login`, { username, password })
      .pipe(tap(res => this.setToken(res.token)));
  }

  saveSetup(apiId: number, apiHash: string, phone: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${BASE}/auth/setup`, { api_id: apiId, api_hash: apiHash, phone });
  }

  // ── Telegram auth ─────────────────────────────────────────────────────────
  checkStatus(): Observable<{ authorized: boolean; hasSetup: boolean }> {
    return this.http.get<{ authorized: boolean; hasSetup: boolean }>(`${BASE}/auth/status`);
  }
  sendCode(): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${BASE}/auth/send-code`, {});
  }
  signIn(code: string): Observable<any> {
    return this.http.post<any>(`${BASE}/auth/sign-in`, { code });
  }
  submit2FA(password: string): Observable<any> {
    return this.http.post<any>(`${BASE}/auth/2fa`, { password });
  }

  // ── Download ──────────────────────────────────────────────────────────────
  getUserId(): number | null {
    const token = this.getToken();
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.sub ?? null;
    } catch { return null; }
  }

  downloadFile(groupId: string, messageId: string | number, fileName: string): void {
    const token = this.getToken();
    const params = new URLSearchParams({
      groupId,
      messageId: String(messageId),
      token: token ?? '',
    });
    const a = document.createElement('a');
    // Use BASE_DIRECT to bypass Angular dev-proxy buffering; in production this is the same origin
    a.href = `${BASE_DIRECT}/api/download/file?${params}`;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  getGroupDownloadLog(groupId: string): Observable<DownloadEntry[]> {
    const userId = this.getUserId();
    if (!userId) return of([]);
    return this.http.get<DownloadEntry[]>(`${BASE}/download/log-db/${groupId}?userId=${userId}`);
  }

  getDownloadCounts(): Observable<Record<string, number>> {
    const userId = this.getUserId();
    if (!userId) return of({});
    return this.http.get<Record<string, number>>(`${BASE}/download/counts-db/${userId}`);
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  // Returns cached groups synchronously (from memory or localStorage) — null if none
  getGroupsFromCache(): { groups: Group[]; total: number; groupCount: number; channelCount: number } | null {
    return this._groupsCache;
  }

  getGroups(limit = 10, offset = 0): Observable<{ groups: Group[]; total: number; groupCount: number; channelCount: number; offset: number; limit: number }> {
    if (this._groupsCache) return of({ ...this._groupsCache, offset, limit });
    return this.http.get<{ groups: Group[]; total: number; groupCount: number; channelCount: number; offset: number; limit: number }>(
      `${BASE}/groups?limit=${limit}&offset=${offset}`
    ).pipe(tap(res => {
      this._groupsCache = { groups: res.groups, total: res.total, groupCount: res.groupCount, channelCount: res.channelCount };
      res.groups.forEach(g => this._groupCache.set(g.id, g));
      localStorage.setItem(GROUPS_CACHE_KEY, JSON.stringify(this._groupsCache));
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
    const token = this.getToken();
    const url = `/api/groups/${groupId}/topics/${topicId}/breakdown/stream${token ? `?token=${token}` : ''}`;
    return new EventSource(url);
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
    const token = this.getToken();
    const url = `/api/groups/${groupId}/breakdown/stream${token ? `?token=${token}` : ''}`;
    return new EventSource(url);
  }

  // ── Photo cache (blob URLs, in-memory only) ───────────────────────────────
  private _photoCache = new Map<string, string>();

  // Fetch photo via HttpClient (JWT attached by interceptor), return blob URL
  fetchGroupPhoto(groupId: string): Promise<string | null> {
    const cached = this._photoCache.get(groupId);
    if (cached) return Promise.resolve(cached);
    return new Promise(resolve => {
      this.http.get(`${BASE}/groups/${groupId}/photo`, { responseType: 'blob' }).subscribe({
        next: (blob: Blob) => {
          const url = URL.createObjectURL(blob);
          this._photoCache.set(groupId, url);
          resolve(url);
        },
        error: () => resolve(null),
      });
    });
  }

  getPhotoFromCache(groupId: string): string | null {
    return this._photoCache.get(groupId) ?? null;
  }

  groupPhotoUrl(groupId: string): string {
    const token = this.getToken();
    return `/api/groups/${groupId}/photo${token ? `?token=${token}` : ''}`;
  }

  // ── Cache helpers ─────────────────────────────────────────────────────────
  bustGroupsCache() {
    this._groupsCache = null;
    localStorage.removeItem(GROUPS_CACHE_KEY);
  }
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

export interface DownloadEntry {
  message_id: string;
  file_name: string | null;
  file_size: number | null;
  ts: number;
}

export interface DownloadResult {
  messageId: string;
  status: string;
  fileName?: string;
  reason?: string;
}
