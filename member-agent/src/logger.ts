import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

function mask(secret: string): string {
  // A very short credential must never be reproduced in full.
  return secret.slice(0, Math.min(4, secret.length - 1)) + "…";
}

/** One shared redactor is used for local output and outgoing job output. */
export class Redactor {
  private variants = new Map<string, string>();
  private pending = new Map<string, string>();
  private ordered: [string, string][] = [];

  register(...secrets: unknown[]): void {
    for (const secret of secrets) {
      if (typeof secret !== "string" || secret.length === 0) continue;
      const forms = new Set([secret, JSON.stringify(secret).slice(1, -1)]);
      try {
        forms.add(encodeURIComponent(secret));
        forms.add(encodeURI(secret));
        forms.add(new URLSearchParams({ value: secret }).toString().slice(6));
      } catch { /* Invalid Unicode is still protected as plain and JSON text. */ }
      for (const form of [...forms]) forms.add(form.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()));
      for (const form of forms) this.variants.set(form, mask(secret));
    }
    this.ordered = [...this.variants].sort(([a], [b]) => b.length - a.length);
  }

  private scan(text: string, streaming: boolean): { output: string; pending: string } {
    let output = "";
    let index = 0;
    while (index < text.length) {
      const match = this.ordered.find(([variant]) => text.startsWith(variant, index));
      if (match) { output += match[1]; index += match[0].length; continue; }
      const remaining = text.slice(index);
      if (streaming && this.ordered.some(([variant]) => variant.startsWith(remaining))) return { output, pending: remaining };
      output += text[index]; index++;
    }
    return { output, pending: "" };
  }

  redact(text: string): string { return this.scan(text, false).output; }

  chunk(stream: string, text: string): string {
    const result = this.scan((this.pending.get(stream) ?? "") + text, true);
    if (result.pending) this.pending.set(stream, result.pending);
    else this.pending.delete(stream);
    return result.output;
  }

  finish(stream: string): string {
    const pending = this.pending.get(stream);
    this.pending.delete(stream);
    // An incomplete secret at EOF is never flushed as ordinary text.
    return pending ? "…" : "";
  }
}

function dayName(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

export class Logger {
  readonly redactor = new Redactor();
  private dir: string;
  private consoleSink: (text: string) => void;

  constructor(dir: string, secrets: string[] = [], consoleSink: (text: string) => void = console.log) {
    this.dir = dir;
    this.consoleSink = consoleSink;
    this.redactor.register(...secrets);
    mkdirSync(dir, { recursive: true });
    const oldest = new Date(); oldest.setHours(0, 0, 0, 0); oldest.setDate(oldest.getDate() - 6);
    const threshold = dayName(oldest);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const match = /^agent-(\d{8})\.log$/.exec(entry.name);
      if (entry.isFile() && match && match[1]! < threshold) unlinkSync(path.join(dir, entry.name));
    }
  }

  write(level: "info" | "warn" | "error" | "debug", message: string, visible = false): void {
    const safe = this.redactor.chunk("local-log", String(message)).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
    const now = new Date();
    const line = `${now.toISOString()} ${level.toUpperCase()} ${safe}`;
    appendFileSync(path.join(this.dir, `agent-${dayName(now)}.log`), line + "\n", "utf8");
    if (visible) this.consoleSink(line);
  }
}
