import { Component, OnInit, OnDestroy, input, signal, computed } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import {
  AuthService, ContentItem, DownloadEntry, GroupBreakdown,
} from '../services/auth.service';

type Tab = 'all' | 'videos' | 'images' | 'pdfs' | 'chat' | 'other' | 'range';
const TAB_TYPE_MAP: Record<Exclude<Tab, 'range'>, string> = {
  all: 'all', videos: 'video', images: 'image', pdfs: 'pdf', chat: 'chat', other: 'other',
};

@Component({
  selector: 'app-topic-detail',
  imports: [RouterLink, DatePipe, DecimalPipe],
  templateUrl: './topic-detail.html',
  styleUrl: './topic-detail.css',
})
export class TopicDetailComponent implements OnInit, OnDestroy {
  groupId  = input<string>('');
  topicId  = input<string>('');

  topicTitle   = signal<string>('');
  groupName    = signal<string>('');
  activeTab    = signal<Tab>('all');
  items        = signal<ContentItem[]>([]);
  loading      = signal(false);
  selectedIds  = signal<Set<string>>(new Set());

  breakdown        = signal<GroupBreakdown | null>(null);
  loadingBreakdown = signal(false);
  scanProgress     = signal<{ processed: number; total: number | null } | null>(null);
  private allItemsCache = signal<ContentItem[] | null>(null);
  private sseSource: EventSource | null = null;

  // Download tracking
  downloadedIds = signal<Set<string>>(new Set());
  pendingIds    = signal<Set<string>>(new Set());
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private downloadQueue: ContentItem[] = [];
  private queueRunning = false;

  downloadCount = computed(() => this.downloadedIds().size);
  menuOpen = signal(false);

  contentSearch = signal('');
  filteredItems = computed(() => {
    const q = this.contentSearch().toLowerCase().trim();
    if (!q) return this.items();
    return this.items().filter(i =>
      (i.fileName ?? '').toLowerCase().includes(q) ||
      (i.text ?? '').toLowerCase().includes(q) ||
      i.type.toLowerCase().includes(q)
    );
  });

  readonly tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'videos', label: 'Videos' },
    { key: 'images', label: 'Images' }, { key: 'pdfs', label: 'PDFs' },
    { key: 'chat', label: 'Chat' }, { key: 'other', label: 'Other' },
    { key: 'range', label: '🎯 Range' },
  ];

  rangeFrom    = signal<number | null>(null);
  rangeTo      = signal<number | null>(null);
  rangeItems   = signal<ContentItem[]>([]);
  rangeLoading = signal(false);
  rangeError   = signal('');
  rangeFetched = signal(false);

  allSelected = computed(() => {
    const ids = this.selectedIds(); const items = this.filteredItems();
    return items.length > 0 && items.every(i => ids.has(String(i.id)));
  });
  someSelected = computed(() => {
    const ids = this.selectedIds(); const items = this.filteredItems();
    return items.some(i => ids.has(String(i.id))) && !this.allSelected();
  });
  selectedCount = computed(() => this.selectedIds().size);

  totalSelectedSize = computed(() => {
    const ids = this.selectedIds();
    const pool = [
      ...this.filteredItems(),
      ...this.rangeItems(),
      ...(this.allItemsCache() ?? []),
    ];
    const seen = new Set<string>();
    const deduped = pool.filter(i => { const k = String(i.id); if (seen.has(k)) return false; seen.add(k); return true; });
    return deduped.filter(i => ids.has(String(i.id))).reduce((sum, i) => sum + (i.fileSize ?? 0), 0);
  });

  totalSelectedSizePartial = computed(() => {
    const ids = this.selectedIds();
    const pool = [
      ...this.filteredItems(),
      ...this.rangeItems(),
      ...(this.allItemsCache() ?? []),
    ];
    const seen = new Set<string>();
    const deduped = pool.filter(i => { const k = String(i.id); if (seen.has(k)) return false; seen.add(k); return true; });
    return deduped.filter(i => ids.has(String(i.id))).some(i => !i.fileSize);
  });

  constructor(private authService: AuthService, private router: Router) {}

  ngOnInit() {
    const gid = this.groupId();
    const tid = Number(this.topicId());
    const cacheKey = `${gid}:${tid}`;

    this.authService.getGroupDownloadLog(gid).subscribe({
      next: (entries: DownloadEntry[]) => {
        this.downloadedIds.set(new Set(entries.map(e => String(e.message_id))));
      },
      error: () => {},
    });

    this.authService.getGroup(gid).subscribe({
      next: (g) => this.groupName.set(g.name),
      error: () => this.groupName.set(gid),
    });

    this.authService.getTopics(gid).subscribe({
      next: (res) => {
        const topic = res.topics.find(t => t.id === tid);
        this.topicTitle.set(topic?.title ?? `Topic ${tid}`);
      },
      error: () => {},
    });

    if (this.authService.hasItemsCache(cacheKey)) {
      const bd = this.authService.getTopicBreakdownCache(cacheKey);
      if (bd) this.breakdown.set(bd);
      this.authService.getTopicContent(gid, tid, 'all').subscribe({
        next: (res) => {
          this.allItemsCache.set(res.items);
          if (this.activeTab() !== 'all') this.applyTabFromCache();
        },
      });
      return;
    }

    this.loadingBreakdown.set(true);
    this.sseSource = this.authService.streamTopicBreakdown(gid, tid);
    this.sseSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.error) { this.loadingBreakdown.set(false); this.sseSource?.close(); return; }
      this.scanProgress.set({ processed: data.processed, total: data.total });
      if (data.done) {
        this.authService.setTopicBreakdownCache(cacheKey, data.counts);
        this.breakdown.set(data.counts);
        this.loadingBreakdown.set(false);
        this.scanProgress.set(null);
        this.sseSource?.close();
        this.authService.getTopicContent(gid, tid, 'all').subscribe({
          next: (res) => {
            this.allItemsCache.set(res.items);
            if (this.activeTab() !== 'all') this.applyTabFromCache();
          },
          error: () => {},
        });
      }
    };
    this.sseSource.onerror = () => { this.loadingBreakdown.set(false); this.sseSource?.close(); };
  }

  setTab(tab: Tab) {
    this.activeTab.set(tab);
    this.selectedIds.set(new Set());
    this.contentSearch.set('');
    if (tab === 'all' || tab === 'range') return;
    const cache = this.allItemsCache();
    if (cache) this.applyTabFromCache();
    else this.loadTabFromServer();
  }

  private applyTabFromCache() {
    const type = TAB_TYPE_MAP[this.activeTab() as Exclude<Tab, 'range'>];
    const cache = this.allItemsCache()!;
    this.items.set(type === 'all' ? cache : cache.filter(m => m.type === type));
  }

  private loadTabFromServer() {
    this.loading.set(true);
    const type = TAB_TYPE_MAP[this.activeTab() as Exclude<Tab, 'range'>];
    this.authService.getTopicContent(this.groupId(), Number(this.topicId()), type).subscribe({
      next: (res) => { this.items.set(res.items); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  fetchRange() {
    const from = this.rangeFrom();
    const to   = this.rangeTo();
    if (!from || !to || from > to) {
      this.rangeError.set('Please enter a valid range (From ≤ To).');
      return;
    }
    this.rangeError.set('');
    this.rangeLoading.set(true);
    this.rangeFetched.set(false);
    this.rangeItems.set([]);
    this.selectedIds.set(new Set());
    this.authService.getTopicContentRange(this.groupId(), Number(this.topicId()), from, to).subscribe({
      next: (res) => {
        this.rangeItems.set(res.items);
        this.rangeLoading.set(false);
        this.rangeFetched.set(true);
      },
      error: (err) => {
        this.rangeError.set(err.error?.error || 'Failed to fetch range.');
        this.rangeLoading.set(false);
      },
    });
  }

  selectAllRange() {
    this.selectedIds.set(new Set(this.rangeItems().map(i => String(i.id))));
  }

  isSelected(id: string | number): boolean { return this.selectedIds().has(String(id)); }
  isDownloaded(id: string | number): boolean { return this.downloadedIds().has(String(id)); }
  isPending(id: string | number): boolean { return this.pendingIds().has(String(id)); }

  toggleItem(id: string | number) {
    const key = String(id); const set = new Set(this.selectedIds());
    if (set.has(key)) set.delete(key); else set.add(key);
    this.selectedIds.set(set);
  }

  toggleAll() {
    if (this.allSelected()) { this.selectedIds.set(new Set()); return; }
    this.selectedIds.set(new Set(this.filteredItems().map(i => String(i.id))));
  }

  private triggerDownload(item: ContentItem): Promise<void> {
    const id = String(item.id);
    const fileName = item.fileName || `file_${item.id}`;

    const pending = new Set(this.pendingIds());
    pending.add(id);
    this.pendingIds.set(pending);

    this.authService.downloadFile(this.groupId(), item.id, fileName);

    return new Promise<void>((resolve) => {
      const poll = () => {
        this.authService.getGroupDownloadLog(this.groupId()).subscribe({
          next: (entries) => {
            const done = entries.some(e => String(e.message_id) === id);
            if (done) {
              const p = new Set(this.pendingIds()); p.delete(id); this.pendingIds.set(p);
              this.pendingTimers.delete(id);
              const d = new Set(this.downloadedIds()); d.add(id); this.downloadedIds.set(d);
              resolve();
            } else {
              const t = setTimeout(poll, 5000);
              this.pendingTimers.set(id, t);
            }
          },
          error: () => { const t = setTimeout(poll, 5000); this.pendingTimers.set(id, t); },
        });
      };
      const existing = this.pendingTimers.get(id);
      if (existing) clearTimeout(existing);
      this.pendingTimers.set(id, setTimeout(poll, 5000));
    });
  }

  private async runQueue() {
    if (this.queueRunning) return;
    this.queueRunning = true;
    while (this.downloadQueue.length > 0) {
      const item = this.downloadQueue.shift()!;
      await this.triggerDownload(item);
    }
    this.queueRunning = false;
  }

  downloadItem(item: ContentItem) {
    const id = String(item.id);
    if (this.isDownloaded(id)) {
      const name = item.fileName || `file_${item.id}`;
      if (!confirm(`"${name}" has already been downloaded.\n\nDownload again?`)) return;
    }
    if (!this.isPending(id)) {
      this.downloadQueue.push(item);
      this.runQueue();
    }
  }

  downloadSelected() {
    const ids = Array.from(this.selectedIds());
    const allItems = [...this.items(), ...this.rangeItems()];
    const alreadyDone = ids.filter(id => this.isDownloaded(id));

    const proceed = () => {
      const pending = new Set(this.pendingIds());
      for (const id of ids) pending.add(id);
      this.pendingIds.set(pending);

      for (const id of ids) {
        const item = allItems.find(it => String(it.id) === id);
        if (item && !this.downloadQueue.some(q => String(q.id) === id)) {
          this.downloadQueue.push(item);
        }
      }
      this.selectedIds.set(new Set());
      this.runQueue();
    };

    if (alreadyDone.length > 0) {
      const msg = alreadyDone.length === ids.length
        ? `All ${ids.length} selected files have already been downloaded.\n\nDownload again?`
        : `${alreadyDone.length} of ${ids.length} files have already been downloaded.\n\nDownload all again?`;
      if (!confirm(msg)) return;
    }
    proceed();
  }

  ngOnDestroy() {
    this.sseSource?.close();
    this.pendingTimers.forEach(t => clearTimeout(t));
  }

  logout() {
    this.authService.logout();
    this.router.navigate(['/']);
    window.location.reload();
  }

  breakdownCount(key: string): number {
    const bd = this.breakdown();
    return bd ? (bd as unknown as Record<string, number>)[key] ?? 0 : 0;
  }
  typeIcon(type: string): string {
    const icons: Record<string, string> = { video: '🎬', image: '🖼️', pdf: '📄', chat: '💬', other: '📎' };
    return icons[type] ?? '📎';
  }
  formatSize(bytes: number | null): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  }
  strId(id: string | number): string { return String(id); }
}
