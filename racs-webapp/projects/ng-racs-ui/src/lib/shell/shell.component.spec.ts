import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { RacsShellComponent } from './shell.component';

describe('RacsShellComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RacsShellComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(RacsShellComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should use RACS as title property', () => {
    const fixture = TestBed.createComponent(RacsShellComponent);
    expect(fixture.componentInstance.title).toBe('RACS');
  });

  it('links the bundled laserline tool', () => {
    const fixture = TestBed.createComponent(RacsShellComponent);
    fixture.detectChanges();
    const link = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>(
      'a[href="tools/laserline/"]',
    );
    expect(link).not.toBeNull();
    expect(link!.target).toBe('_blank');
  });

  it('opens a tool once and focuses its window after that', () => {
    const fixture = TestBed.createComponent(RacsShellComponent);
    const app = fixture.componentInstance;
    const win = { closed: false, focus: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(win);
    const click = () => new MouseEvent('click', { button: 0, cancelable: true });

    const first = click();
    app.openTool(app.tools[0], first);
    expect(first.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toMatch(/\/tools\/laserline\/$/);
    expect(open.mock.calls[0][1]).toBe('racs-laserline');

    app.openTool(app.tools[0], click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalled();

    // A modified click is left to the browser (new tab, …).
    const ctrl = new MouseEvent('click', { button: 0, ctrlKey: true, cancelable: true });
    app.openTool(app.tools[0], ctrl);
    expect(ctrl.defaultPrevented).toBe(false);
    open.mockRestore();
  });
});
