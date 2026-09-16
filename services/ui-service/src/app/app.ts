import { Component, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterOutlet } from '@angular/router';
import { AuthService } from './services/auth.service';

type Step = 'checking' | 'app-login' | 'app-register' | 'setup' | 'phone' | 'otp' | 'two-fa' | 'done';

@Component({
  selector: 'app-root',
  imports: [FormsModule, RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  step = signal<Step>('checking');
  error = signal('');
  loading = signal(false);

  // App-level auth
  appUsername = signal('');
  appPassword = signal('');
  registerUsername = signal('');
  registerPassword = signal('');
  registerConfirm = signal('');

  // Telegram setup
  apiId = signal('');
  apiHash = signal('');
  setupPhone = signal('');

  // Telegram OTP / 2FA
  code = signal('');
  password = signal('');

  constructor(private authService: AuthService, private router: Router) {}

  ngOnInit() {
    if (!this.authService.isLoggedIn()) {
      this.step.set('app-login');
      return;
    }
    this.authService.checkStatus().subscribe({
      next: (res) => {
        if (res.authorized) {
          this.step.set('done');
          this.router.navigate(['/']);
        } else if (!res.hasSetup) {
          this.step.set('setup');
        } else {
          this.step.set('phone');
        }
      },
      error: (err) => {
        if (err.status === 401) {
          this.authService.clearToken();
        }
        this.step.set('app-login');
      },
    });
  }

  doAppLogin() {
    if (!this.appUsername() || !this.appPassword()) return;
    this.loading.set(true);
    this.error.set('');
    this.authService.appLogin(this.appUsername(), this.appPassword()).subscribe({
      next: () => { this.loading.set(false); this.ngOnInit(); },
      error: (err) => {
        this.error.set(err.error?.error || 'Login failed');
        this.loading.set(false);
      },
    });
  }

  doRegister() {
    if (this.registerPassword() !== this.registerConfirm()) {
      this.error.set('Passwords do not match');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.authService.register(this.registerUsername(), this.registerPassword()).subscribe({
      next: () => {
        this.loading.set(false);
        this.appUsername.set(this.registerUsername());
        this.appPassword.set(this.registerPassword());
        this.step.set('app-login');
      },
      error: (err) => {
        this.error.set(err.error?.error || 'Registration failed');
        this.loading.set(false);
      },
    });
  }

  saveSetup() {
    const apiId = parseInt(this.apiId());
    if (!apiId || !this.apiHash() || !this.setupPhone()) {
      this.error.set('All fields are required');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.authService.saveSetup(apiId, this.apiHash(), this.setupPhone()).subscribe({
      next: () => { this.loading.set(false); this.step.set('phone'); },
      error: (err) => {
        this.error.set(err.error?.error || 'Setup failed');
        this.loading.set(false);
      },
    });
  }

  sendCode() {
    this.loading.set(true);
    this.error.set('');
    this.authService.sendCode().subscribe({
      next: () => { this.step.set('otp'); this.loading.set(false); },
      error: (err) => { this.error.set(err.error?.error || 'Failed to send code'); this.loading.set(false); },
    });
  }

  signIn() {
    if (!this.code()) return;
    this.loading.set(true);
    this.error.set('');
    this.authService.signIn(this.code()).subscribe({
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
