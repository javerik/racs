import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRacs, racsSessionInterceptor } from 'ng-racs-core';
import { AppComponent } from './app/app';

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(withInterceptors([racsSessionInterceptor])),
    // The API behind the dev server's proxy; an absolute URL works too:
    // provideRacs({ apiBase: 'http://192.168.10.5:8742/api/v1' })
    provideRacs(),
  ],
}).catch((err) => console.error(err));
