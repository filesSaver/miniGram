import { Component, OnInit, signal, computed } from '@angular/core';
import { Router } from '@angular/router';
import { DecimalPipe, DatePipe } from '@angular/common';
import { AuthService, Group } from '../services/auth.service';

@Component({
  selector: 'app-home',
  imports: [DecimalPipe, DatePipe],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class HomeComponent implements OnInit {
  groups        = signal<Group[]>([]);
  loadingGroups = signal(false);
  totalGroups   = signal(0);
  groupCount    = signal(0);
  channelCount  = signal(0);
  downloadCounts = signal<Record<string, number>>({});
  searchQuery   = signal('');

  filteredGroups = computed(() => {
    const q = this.searchQuery().toLowerCase().trim();
    if (!q) return this.groups();
    return this.groups().filter(g =>
      g.name.toLowerCase().includes(q) ||
      (g.username ?? '').toLowerCase().includes(q)
    );
  });

  constructor(private authService: AuthService, private router: Router) {}

  ngOnInit() {
    this.loadGroups();
    this.authService.getDownloadCounts().subscribe({
      next: (counts) => this.downloadCounts.set(counts),
      error: () => {},
    });
  }

  loadGroups() {
    this.loadingGroups.set(true);
    this.authService.getGroups(9999, 0).subscribe({
      next: (res) => {
        this.groups.set(res.groups);
        this.totalGroups.set(res.total);
        this.groupCount.set(res.groupCount);
        this.channelCount.set(res.channelCount);
        this.loadingGroups.set(false);
      },
      error: () => this.loadingGroups.set(false),
    });
  }

  goToGroup(id: string) { this.router.navigate(['/group', id]); }
}
