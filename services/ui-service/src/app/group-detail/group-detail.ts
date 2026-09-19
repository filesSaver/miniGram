import { Component, OnInit, OnDestroy, input, signal, computed } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import {
  AuthService, ContentItem, DownloadEntry, Group, GroupStats, GroupBreakdown, Topic,
} from '../services/auth.service';

type Tab = 'all' | 'videos' | 'images' | 'pdfs' | 'chat' | 'other' | 'range';

const TAB_TYPE_MAP: Record<Exclude<Tab, 'range'>, string> = {
  all: 'all', videos: 'video', images: 'image', pdfs: 'pdf', chat: 'chat', other: 'other',
};

@Component({
  selector: 'app-group-detail',
  imports: [RouterLink, DatePipe, DecimalPipe],
  templateUrl: './group-detail.html',
  styleUrl: './group-detail.css',
})
export class GroupDetailComponent implements OnInit, OnDestroy {
  groupId = input<string>('');

  activeTab = signal<Tab>('all');
  items = signal<ContentItem[]>([]);
  loading = signal(false);
  selectedIds = signal<Set<string>>(new Set());
  groupName = signal<string>('');
  group = signal<Group | null>(null);
  groupStats = signal<GroupStats | null>(null);
  groupBreakdown = signal<GroupBreakdown | null>(null);
  loadingBreakdown = signal(false);
  scanProgress = signal<{ processed: number; total: number } | null>(null);

  private sseSource: EventSource | null = null;
  private allItemsCache = signal<ContentItem[] | null>(null);

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

  topics = signal<Topic[]>([]);
  loadingTopics = signal(false);

  rangeFrom    = signal<number | null>(null);
  rangeTo      = signal<number | null>(null);
  rangeItems   = signal<ContentItem[]>([]);
  rangeLoading = signal(false);
  rangeError   = signal('');
  rangeFetched = signal(false);

  allSelected = computed(() => {
    const ids = this.selectedIds();
    const items = this.filteredItems();
    return items.length > 0 && items.every(i => ids.has(String(i.id)));
  });

  someSelected = computed(() => {
    const ids = this.selectedIds();
    const items = this.filteredItems();
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

  readonly tabs: { key: Tab; label: string }[] = [
    { key: 'all',    label: 'All'    },
    { key: 'videos', label: 'Videos' },
    { key: 'images', label: 'Images' },
    { key: 'pdfs',   label: 'PDFs'   },
    { key: 'chat',   label: 'Chat'   },
    { key: 'other',  label: 'Other'  },
    { key: 'range',  label: '🎯 Range' },
  ];

  constructor(protected authService: AuthService, private router: Router) {}

  ngOnInit() {
    const gid = this.groupId();

    this.authService.getGroupDownloadLog(gid).subscribe({
      next: (entries: DownloadEntry[]) => {
        this.downloadedIds.set(new Set(entries.map(e => String(e.message_id))));
      },
      error: () => {},
    });

    this.authService.getGroup(gid).subscribe({
      next: (g) => {
        this.group.set(g);
        this.groupName.set(g.name);
        if (g.forum) {
          this.loadingTopics.set(true);
          this.authService.getTopics(gid).subscribe({
            next: (res) => { this.topics.set(res.topics); this.loadingTopics.set(false); },
            error: () => this.loadingTopics.set(false),
          });
        }
      },
      error: () => this.groupName.set(gid),
    });

    this.authService.getGroupStats(gid).subscribe({
      next: (stats) => this.groupStats.set(stats),
      error: () => {},
    });

    if (this.authService.hasBreakdownCache(gid) && this.authService.hasItemsCache(gid)) {
      this.authService.getGroupBreakdown(gid).subscribe({ next: (bd) => this.groupBreakdown.set(bd) });
      this.authService.getGroupContent(gid, 'all', 999999, 0).subscribe({
        next: (res) => {
          this.allItemsCache.set(res.items);
          if (this.activeTab() !== 'all') this.applyTabFromCache();
        },
      });
      return;
    }

    this.loadingBreakdown.set(true);
    this.sseSource = this.authService.streamGroupBreakdown(gid);
    this.sseSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.error) { this.loadingBreakdown.set(false); this.sseSource?.close(); return; }
      this.scanProgress.set({ processed: data.processed, total: data.total });
      if (data.done) {
        this.authService.setBreakdownCache(gid, data.counts);
        this.groupBreakdown.set(data.counts);
        this.loadingBreakdown.set(false);
        this.scanProgress.set(null);
        this.sseSource?.close();
        this.authService.getGroupContent(gid, 'all', 999999, 0).subscribe({
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
    const tab = this.activeTab() as Exclude<Tab, 'range'>;
    const type = TAB_TYPE_MAP[tab];
    const cache = this.allItemsCache()!;
    this.items.set(type === 'all' ? cache : cache.filter(m => m.type === type));
  }

  fetchRange() {
    const from = this.rangeFrom(), to = this.rangeTo();
    if (!from || !to || from > to) { this.rangeError.set('Please enter a valid range (From ≤ To).'); return; }
    this.rangeError.set('');
    this.rangeLoading.set(true);
    this.rangeFetched.set(false);
    this.rangeItems.set([]);
    this.selectedIds.set(new Set());
    this.authService.getContentRange(this.groupId(), from, to).subscribe({
      next: (res) => { this.rangeItems.set(res.items); this.rangeLoading.set(false); this.rangeFetched.set(true); },
      error: (err) => { this.rangeError.set(err.error?.error || 'Failed to fetch range.'); this.rangeLoading.set(false); },
    });
  }

  selectAllRange() {
    this.selectedIds.set(new Set(this.rangeItems().map(i => String(i.id))));
  }

  private loadTabFromServer() {
    this.loading.set(true);
    const type = TAB_TYPE_MAP[this.activeTab() as Exclude<Tab, 'range'>];
    this.authService.getGroupContent(this.groupId(), type, 999999, 0).subscribe({
      next: (res) => { this.items.set(res.items); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  goToTopic(topicId: number) {
    this.router.navigate(['/group', this.groupId(), 'topic', topicId]);
  }

  trueFlagsOf(g: Group): string[] {
    const flags: string[] = [];
    if (g.verified)        flags.push('Verified');
    if (g.broadcast)       flags.push('Broadcast');
    if (g.megagroup)       flags.push('Megagroup');
    if (g.gigagroup)       flags.push('Gigagroup');
    if (g.forum)           flags.push('Forum');
    if (g.hasLink)         flags.push('Has public link');
    if (g.hasGeo)          flags.push('Has location');
    if (g.slowmodeEnabled) flags.push('Slowmode');
    if (g.noforwards)      flags.push('No forwards');
    if (g.joinToSend)      flags.push('Join to send');
    if (g.joinRequest)     flags.push('Join request');
    return flags;
  }

  isSelected(id: string | number): boolean { return this.selectedIds().has(String(id)); }

  toggleItem(id: string | number) {
    const key = String(id);
    const set = new Set(this.selectedIds());
    if (set.has(key)) set.delete(key); else set.add(key);
    this.selectedIds.set(set);
  }

  toggleAll() {
    if (this.allSelected()) { this.selectedIds.set(new Set()); return; }
    this.selectedIds.set(new Set(this.filteredItems().map(i => String(i.id))));
  }

  isDownloaded(id: string | number): boolean { return this.downloadedIds().has(String(id)); }
  isPending(id: string | number): boolean { return this.pendingIds().has(String(id)); }

  // Trigger one download and return a Promise that resolves when it completes (DB confirmed)
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

  // Run the download queue one file at a time — browser only handles 1 download at once
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
      // Mark all as pending immediately so the UI updates, then queue sequentially
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

  strId(id: string | number): string { return String(id); }

  breakdownCount(key: string): number {
    const bd = this.groupBreakdown();
    if (!bd) return 0;
    return (bd as unknown as Record<string, number>)[key] ?? 0;
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

  logout() {
    this.authService.logout();
    window.location.reload();
  }
}
