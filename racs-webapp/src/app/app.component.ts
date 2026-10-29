import { Component } from '@angular/core';
import { RacsShellComponent } from 'ng-racs-ui';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RacsShellComponent],
  template: '<racs-shell />',
})
export class AppComponent {}
