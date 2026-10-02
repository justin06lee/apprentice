/**
 * The whole of what the window can reach in the main process: one call, one
 * event stream, and the path of a dropped file.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("apprentice", {
  call: (method: string, args: unknown[]) => ipcRenderer.invoke("rpc", method, args),
  onEvent: (listener: (name: string, payload: unknown) => void) => {
    const wrapped = (_e: unknown, name: string, payload: unknown) => listener(name, payload);
    ipcRenderer.on("event", wrapped);
    return () => ipcRenderer.removeListener("event", wrapped);
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  platform: process.platform,
});
