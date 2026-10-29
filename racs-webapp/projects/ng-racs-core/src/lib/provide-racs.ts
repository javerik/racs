import { EnvironmentProviders, inject, makeEnvironmentProviders, provideAppInitializer } from '@angular/core';
import { RACS_CONFIG, resolveRacsConfig, type RacsConfig } from './config';
import { ServerEventsService } from './services/server-events.service';
import { SessionService } from './services/session.service';

/**
 * Sets up the RACS services: the configuration and, unless `autoStart` is false, the client
 * session, started in the background at app start (requests wait for it), and the events socket,
 * which keeps it alive. The app's `HttpClient` needs `racsSessionInterceptor`:
 *
 * ```ts
 * providers: [provideHttpClient(withInterceptors([racsSessionInterceptor])), provideRacs()]
 * ```
 */
export function provideRacs(config: Partial<RacsConfig> = {}): EnvironmentProviders {
  const resolved = resolveRacsConfig(config);
  return makeEnvironmentProviders([
    { provide: RACS_CONFIG, useValue: resolved },
    resolved.autoStart
      ? provideAppInitializer(() => {
          inject(SessionService).start();
          inject(ServerEventsService);
        })
      : [],
  ]);
}
