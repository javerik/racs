import { Injectable } from '@angular/core';

/** A standalone web app bundled into the web root (see scripts/build-laserline.sh). */
export interface Tool {
  id: string;
  /** Relative to the base href. */
  href: string;
  label: string;
}

/**
 * Laserline, bundled under `tools/laserline/` by scripts/build-laserline.sh. The default of
 * `RacsConfig.tools`; the laserline calibration opens the configured tool of this id.
 */
export const LASERLINE_TOOL: Tool = { id: 'laserline', href: 'tools/laserline/', label: 'Laserline' };

/**
 * Opens the bundled tools, each in a named window of its own, and focuses an open one instead of
 * reloading it. Shared by the sidebar and the features that drive a tool (the laserline
 * calibration).
 */
@Injectable({ providedIn: 'root' })
export class ToolWindowService {
  private readonly windows = new Map<string, Window>();

  /**
   * Open `tool`, or focus its window. Browsers allow a new window only in response to a user
   * action. Returns false if the pop-up was blocked and a plain tab opened instead (or nothing).
   */
  open(tool: Tool): boolean {
    const open = this.windows.get(tool.id);
    if (open && !open.closed) {
      open.focus();
      return true;
    }
    const url = new URL(tool.href, document.baseURI).href;
    // Size features ask for a window rather than a tab; mobile browsers open a tab anyway.
    const win = window.open(url, `racs-${tool.id}`, 'popup,width=1440,height=900');
    if (win) {
      this.windows.set(tool.id, win);
      return true;
    }
    // Blocked as a pop-up: fall back to a plain new tab.
    window.open(url, '_blank');
    return false;
  }
}
