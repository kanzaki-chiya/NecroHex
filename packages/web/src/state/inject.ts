import { inject, type InjectionKey } from "vue";
import type { Store } from "./store.ts";

export const STORE: InjectionKey<Store> = Symbol("store");

export function useStore(): Store {
  const s = inject(STORE);
  if (!s) throw new Error("store is not provided");
  return s;
}

/** 在浏览器里下载一段字节或文本。 */
export function download(data: Uint8Array | string, name: string, type: string): void {
  const blob = new Blob([typeof data === "string" ? data : (data as Uint8Array<ArrayBuffer>)], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
