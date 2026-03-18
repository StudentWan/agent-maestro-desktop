export type IpcChannels =
  | "auth:start-login"
  | "auth:logout"
  | "auth:get-status"
  | "proxy:start"
  | "proxy:stop"
  | "proxy:get-status"
  | "token:get-info"
  | "config:get"
  | "models:get-available"
  | "models:get-selected"
  | "models:set-selected"
  | "settings:get-auto-start"
  | "settings:set-auto-start";

export type IpcEvents =
  | "auth:status-changed"
  | "proxy:status-changed"
  | "token:info-changed"
  | "proxy:request-log";
