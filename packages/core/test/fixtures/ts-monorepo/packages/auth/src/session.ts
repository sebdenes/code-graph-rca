import { log } from "@fixture/shared";

export class Session {
  readonly user: string;
  lastSeen: number;

  constructor(user: string) {
    this.user = user;
    this.lastSeen = Date.now();
  }

  touch(): void {
    this.lastSeen = Date.now();
    log("debug", `session touch: ${this.user}`);
  }

  refresh(): void {
    this.touch();
    log("info", `session refresh: ${this.user}`);
  }
}
