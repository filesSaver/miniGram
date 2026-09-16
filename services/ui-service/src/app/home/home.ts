import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { Router } from '@angular/router';
import { DecimalPipe, DatePipe } from '@angular/common';
import { AuthService, Group } from '../services/auth.service';

type PhotoState = 'loading' | 'loaded' | 'error';

@Component({
  selector: 'app-home',
  imports: [DecimalPipe, DatePipe],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class HomeComponent implements OnInit, OnDestroy {
  groups         = signal<Group[]>([]);
  loadingGroups  = signal(true);
  totalGroups    = signal(0);
  groupCount     = signal(0);
  channelCount   = signal(0);
  downloadCounts = signal<Record<string, number>>({});
  searchQuery    = signal('');

  // Per-group photo state: drives shimmer vs img vs nothing
  photoStates    = signal<Record<string, PhotoState>>({});
  photoUrls      = signal<Record<string, string>>({});

  private _retryTimers: ReturnType<typeof setTimeout>[] = [];

  filteredGroups = computed(() => {
    const q = this.searchQuery().toLowerCase().trim();
    if (!q) return this.groups();
    return this.groups().filter(g =>
      g.name.toLowerCase().includes(q) ||
      (g.username ?? '').toLowerCase().includes(q)
    );
  });

  constructor(protected authService: AuthService, private router: Router) {}

  ngOnInit() {
    this.authService.bustGroupsCache();
    this.authService.getGroups(9999, 0).subscribe({
      next: (res) => {
        this.groups.set(res.groups);
        this.totalGroups.set(res.total);
        this.groupCount.set(res.groupCount);
        this.channelCount.set(res.channelCount);
        this.loadingGroups.set(false);

        // Mark all as loading, then fetch in batches of 10 with 2s gap
        const states: Record<string, PhotoState> = {};
        res.groups.forEach(g => states[g.id] = 'loading');
        this.photoStates.set(states);
        this._loadPhotosBatched(res.groups.map(g => g.id));
      },
      error: () => this.loadingGroups.set(false),
    });

    this.authService.getDownloadCounts().subscribe({
      next: (counts) => this.downloadCounts.set(counts),
      error: () => {},
    });
  }

  ngOnDestroy() {
    this._retryTimers.forEach(t => clearTimeout(t));
  }

  private _loadPhotosBatched(ids: string[], batchSize = 10, gapMs = 2000) {
    const loadBatch = (startIndex: number) => {
      if (startIndex >= ids.length) return;
      const batch = ids.slice(startIndex, startIndex + batchSize);
      Promise.all(batch.map(id => this._loadPhoto(id))).then(() => {
        if (startIndex + batchSize < ids.length) {
          const t = setTimeout(() => loadBatch(startIndex + batchSize), gapMs);
          this._retryTimers.push(t);
        }
      });
    };
    loadBatch(0);
  }

  private _loadPhoto(groupId: string): Promise<void> {
    return this.authService.fetchGroupPhoto(groupId).then(url => {
      if (url) {
        this.photoUrls.update(u => ({ ...u, [groupId]: url }));
        this.photoStates.update(s => ({ ...s, [groupId]: 'loaded' }));
      } else {
        // No photo available — show initial instead of shimmer forever
        this.photoStates.update(s => ({ ...s, [groupId]: 'error' }));
      }
    });
  }

  photoState(groupId: string): PhotoState {
    return this.photoStates()[groupId] ?? 'loading';
  }

  photoUrl(groupId: string): string {
    return this.photoUrls()[groupId] ?? '';
  }

  goToGroup(id: string) { this.router.navigate(['/group', id]); }

  logout() {
    this.authService.logout();
    this.router.navigate(['/']);
    window.location.reload();
  }
}
