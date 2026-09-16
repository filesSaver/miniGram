import { Component, OnInit, OnDestroy, input, signal, computed } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import {
  AuthService, ContentItem, DownloadJob, DownloadLog,
  DownloadLogEntry, ItemDownloadStatus, ItemProgress, Group, GroupStats, GroupBreakdown, Topic,
} from '../services/auth.service';

type Tab = 'all' | 'videos' | 'images' | 'pdfs' | 'chat' | 'other' | 'range';

const TAB_TYPE_MAP: Record<Exclude<Tab, 'range'>, string> = {
  all: 'all', videos: 'video', images: 'image', pdfs: 'pdf', chat: 'chat', other: 'other',
};

export interface DestOption { key: string; label: string; path: string; }

function sanitizeFolderName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download';
}

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

  // Full local cache — populated once; all tabs read from it instantly
  private allItemsCache = signal<ContentItem[] | null>(null);

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

  // Download state
  showLocationPicker = signal(false);
  destOptions = signal<DestOption[]>([]);
  selectedDest = signal<string>('downloads');
  downloading = signal(false);
  downloadResult = signal<string>('');
  downloadProgress = signal<{ done: number; total: number } | null>(null);

  // Per-item live state (from active job)
  itemStatuses = signal<Record<string, ItemDownloadStatus>>({});
  itemProgresses = signal<Record<string, ItemProgress>>({});

  // Persistent log loaded from backend on init (survives restarts)
  downloadLog = signal<DownloadLog>({});

  private readonly pollTimer: { ref: ReturnType<typeof setTimeout> | null } = { ref: null };

  readonly tabs: { key: Tab; label: string }[] = [
    { key: 'all',    label: 'All'    },
    { key: 'videos', label: 'Videos' },
    { key: 'images', label: 'Images' },
    { key: 'pdfs',   label: 'PDFs'   },
    { key: 'chat',   label: 'Chat'   },
    { key: 'other',  label: 'Other'  },
    { key: 'range',  label: '🎯 Range' },
  ];

  // Range tab state
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

  constructor(protected authService: AuthService, private router: Router) {}

  ngOnInit() {
    const gid = this.groupId();

    this.authService.getGroup(gid).subscribe({
      next: (g) => {
        this.group.set(g);
        this.groupName.set(g.name);
        this.loadDownloadLog();
        if (g.forum) {
          this.loadingTopics.set(true);
          this.authService.getTopics(gid).subscribe({
            next: (res) => { this.topics.set(res.topics); this.loadingTopics.set(false); },
            error: () => this.loadingTopics.set(false),
          });
        }
      },
      error: () => { this.groupName.set(gid); this.loadDownloadLog(); },
    });

    this.authService.getDownloadLocations().subscribe({
      next: (locs) => {
        this.destOptions.set([
          { key: 'desktop',   label: 'Desktop',      path: locs.desktop   },
          { key: 'downloads', label: 'Downloads',     path: locs.downloads },
          { key: 'custom',    label: 'Custom folder', path: locs.custom    },
        ]);
      },
    });

    this.authService.getGroupStats(gid).subscribe({
      next: (stats) => this.groupStats.set(stats),
      error: () => {},
    });

    // If breakdown + items are already cached, restore instantly — no scan needed
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

    // First visit — run SSE scan
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

  private loadDownloadLog() {
    const folder = sanitizeFolderName(this.groupName() || this.groupId());
    this.authService.getDownloadLog(this.selectedDest(), folder).subscribe({
      next: (log) => this.downloadLog.set(log),
      error: () => {},
    });
  }

  setTab(tab: Tab) {
    this.activeTab.set(tab);
    this.selectedIds.set(new Set());
    this.contentSearch.set('');
    if (tab === 'all' || tab === 'range') return;

    const cache = this.allItemsCache();
    if (cache) {
      this.applyTabFromCache();
    } else {
      this.loadTabFromServer();
    }
  }

  private applyTabFromCache() {
    const tab = this.activeTab() as Exclude<Tab, 'range'>;
    const type = TAB_TYPE_MAP[tab];
    const cache = this.allItemsCache()!;
    const filtered = type === 'all' ? cache : cache.filter(m => m.type === type);
    this.items.set(filtered);
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
    this.authService.getContentRange(this.groupId(), from, to).subscribe({
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
    const selectable = this.rangeItems()
      .filter(i => this.logStatus(i.id) !== 'done')
      .map(i => String(i.id));
    this.selectedIds.set(new Set(selectable));
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
    if (set.has(key)) set.delete(key);
    else set.add(key);
    this.selectedIds.set(set);
  }

  toggleAll() {
    if (this.allSelected()) {
      this.selectedIds.set(new Set());
    } else {
      const selectable = this.filteredItems()
        .filter(i => this.logStatus(i.id) !== 'done')
        .map(i => String(i.id));
      this.selectedIds.set(new Set(selectable));
    }
  }

  logEntry(id: string | number): DownloadLogEntry | null {
    return this.downloadLog()[String(id)] ?? null;
  }

  logStatus(id: string | number): string {
    return this.downloadLog()[String(id)]?.status ?? 'not-downloaded';
  }

  itemStatus(id: string | number): ItemDownloadStatus {
    return this.itemStatuses()[String(id)] ?? 'idle';
  }

  itemProgress(id: string | number): ItemProgress {
    return this.itemProgresses()[String(id)] ?? { pct: 0, downloaded: 0, total: 0 };
  }

  displayStatus(id: string | number): string {
    const live = this.itemStatuses()[String(id)];
    if (live && live !== 'idle') return live;
    return this.logStatus(id);
  }

  openLocationPicker() { this.showLocationPicker.set(true); }
  cancelLocationPicker() { this.showLocationPicker.set(false); }
  selectDest(key: string) { this.selectedDest.set(key); this.loadDownloadLog(); }

  confirmDownload() {
    this.showLocationPicker.set(false);
    this.startDownload();
  }

  private startDownload() {
    const ids = Array.from(this.selectedIds());
    if (ids.length === 0) return;

    const statuses: Record<string, ItemDownloadStatus> = {};
    const progresses: Record<string, ItemProgress> = {};
    ids.forEach(id => { statuses[id] = 'queued'; progresses[id] = { pct: 0, downloaded: 0, total: 0 }; });
    this.itemStatuses.set(statuses);
    this.itemProgresses.set(progresses);

    this.downloading.set(true);
    this.downloadResult.set('');
    this.downloadProgress.set({ done: 0, total: ids.length });
    this.selectedIds.set(new Set());

    this.authService.downloadBatch(this.groupId(), this.groupName(), ids, this.selectedDest()).subscribe({
      next: (res) => { this.pollJobStatus(res.jobId, res.total); },
      error: (err) => {
        this.downloading.set(false);
        this.downloadProgress.set(null);
        this.downloadResult.set(`Error: ${err.error?.error || 'Download failed'}`);
        const s = { ...this.itemStatuses() };
        ids.forEach(id => s[id] = 'error');
        this.itemStatuses.set(s);
      },
    });
  }

  retryItem(id: string) {
    const s = { ...this.itemStatuses() };
    s[id] = 'idle';
    this.itemStatuses.set(s);
    this.selectedIds.set(new Set([id]));
    this.openLocationPicker();
  }

  openFile(filePath: string) { this.authService.openPath(filePath).subscribe({ error: () => {} }); }

  openFolder(filePath: string) {
    const folder = filePath.substring(0, filePath.lastIndexOf('/'));
    this.authService.openPath(folder).subscribe({ error: () => {} });
  }

  private pollJobStatus(jobId: string, total: number) {
    this.pollTimer.ref = setTimeout(() => {
      this.authService.getDownloadStatus(jobId).subscribe({
        next: (job: DownloadJob) => {
          const statuses = { ...this.itemStatuses() };
          const progresses = { ...this.itemProgresses() };
          for (const [msgId, s] of Object.entries(job.itemStatus)) statuses[msgId] = s as ItemDownloadStatus;
          for (const [msgId, p] of Object.entries(job.itemProgress)) progresses[msgId] = p;
          this.itemStatuses.set(statuses);
          this.itemProgresses.set(progresses);
          this.downloadProgress.set({ done: job.done, total });

          if (job.status === 'running') {
            this.pollJobStatus(jobId, total);
          } else {
            this.downloading.set(false);
            this.downloadProgress.set(null);
            if (job.status === 'done') {
              const destLabel = this.destOptions().find(d => d.key === this.selectedDest())?.label || 'folder';
              this.downloadResult.set(`Downloaded ${job.downloaded}/${total} files to your ${destLabel}`);
              this.loadDownloadLog();
            } else {
              this.downloadResult.set(`Error: ${job.error || 'Download failed'}`);
            }
          }
        },
        error: () => this.pollJobStatus(jobId, total),
      });
    }, 1500);
  }

  ngOnDestroy() {
    if (this.pollTimer.ref) clearTimeout(this.pollTimer.ref);
    this.sseSource?.close();
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
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  logout() {
    this.authService.logout();
    window.location.reload();
  }
}
