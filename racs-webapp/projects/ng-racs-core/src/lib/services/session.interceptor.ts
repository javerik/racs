import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { SessionService } from './session.service';
import { RACS_CONFIG } from '../config';

export const SESSION_HEADER = 'X-Racs-Session';

/**
 * Sends this tab's session with every API request (`X-Racs-Session`), waiting for it at
 * start-up. A request refused with `401` (the session expired) renews the session and is sent
 * once more with the new one. Without a session (the server could not be reached) a request
 * goes out anonymous. The session routes themselves are left alone.
 */
export const racsSessionInterceptor: HttpInterceptorFn = (req, next) => {
  const api = inject(RACS_CONFIG).apiBase;
  if (!req.url.startsWith(`${api}/`) || req.url.startsWith(`${api}/sessions`) || req.headers.has(SESSION_HEADER)) {
    return next(req);
  }
  const session = inject(SessionService);
  const send = (id: string | null, retry: boolean): ReturnType<typeof next> =>
    next(id ? req.clone({ setHeaders: { [SESSION_HEADER]: id } }) : req).pipe(
      catchError((e: unknown) =>
        retry && id && e instanceof HttpErrorResponse && e.status === 401
          ? from(session.renew(id)).pipe(switchMap((fresh) => (fresh ? send(fresh, false) : throwError(() => e))))
          : throwError(() => e),
      ),
    );
  return from(session.ensure()).pipe(switchMap((id) => send(id, true)));
};
