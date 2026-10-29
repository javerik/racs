import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { RacsShellComponent } from 'ng-racs-ui';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  it('renders the RACS shell', async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const shell = (fixture.nativeElement as HTMLElement).querySelector('racs-shell');
    expect(shell).not.toBeNull();
    expect(fixture.debugElement.children[0].componentInstance).toBeInstanceOf(RacsShellComponent);
  });
});
