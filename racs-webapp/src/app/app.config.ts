import { ApplicationConfig } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';

import { racsRoutes } from 'ng-racs-ui';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRacs, racsSessionInterceptor } from 'ng-racs-core';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(racsRoutes, withComponentInputBinding()),
    provideAnimationsAsync(),
    provideHttpClient(withInterceptors([racsSessionInterceptor])),
    // The session starts in the background (requests wait for it), and the events socket, which
    // keeps it alive, follows it.
    provideRacs(),
  ],
};
