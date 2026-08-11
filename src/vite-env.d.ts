/// <reference types="vite/client" />

import type { HereDesktopApi } from "../electron/shared/contracts";

declare global {
  interface Window {
    here: HereDesktopApi;
  }
}

export {};
