import 'react';

declare module 'react' {
  interface HTMLAttributes<T> {
    's-html'?: string;
  }
}
