import { Component, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterOutlet } from '@angular/router';
import { AuthService } from './services/auth.service';

type Step = 'checking' | 'phone' | 'otp' | 'two-fa' | 'done';

@Component({
  selector: 'app-root',
  imports: [FormsModule, RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  step = signal<Step>('checking');
  phoneNumber = signal('');
  code = signal('');
  password = signal('');
  error = signal('');
  loading = signal(false);

  constructor(private authService: AuthService, private router: Router) {}

  ngOnInit() {
    this.authService.checkStatus().subscribe({
      next: (res) => {
        if (res.authorized) {
          this.step.set('done');
          this.router.navigate(['/']);
        } else {
          this.step.set('phone');
        }
      },
      error: () => this.step.set('phone'),
    });
  }

  sendCode() {
    if (!this.phoneNumber()) return;
    this.loading.set(true);
    this.error.set('');
    this.authService.sendCode(this.phoneNumber()).subscribe({
      next: () => { this.step.set('otp'); this.loading.set(false); },
      error: (err) => { this.error.set(err.error?.error || 'Failed to send code'); this.loading.set(false); },
    });
  }

  signIn() {
    if (!this.code()) return;
    this.loading.set(true);
    this.error.set('');
    this.authService.signIn(this.phoneNumber(), this.code()).subscribe({
      next: () => { this.step.set('done'); this.router.navigate(['/']); this.loading.set(false); },
      error: (err) => {
        if (err.error?.require2FA) { this.step.set('two-fa'); }
        else { this.error.set(err.error?.error || 'Invalid code'); }
        this.loading.set(false);
      },
    });
  }

  submit2FA() {
    if (!this.password()) return;
    this.loading.set(true);
    this.error.set('');
    this.authService.submit2FA(this.password()).subscribe({
      next: () => { this.step.set('done'); this.router.navigate(['/']); this.loading.set(false); },
      error: (err) => { this.error.set(err.error?.error || 'Wrong password'); this.loading.set(false); },
    });
  }
}
