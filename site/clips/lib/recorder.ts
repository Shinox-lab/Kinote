import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import type { Frame } from './timeline';

/** Records a page as JPEG frames through the Chrome DevTools screencast, which is sharper than recordVideo. */
export class Recorder {
  private session: CDPSession | null = null;
  private frames: Frame[] = [];
  private writes: Promise<void>[] = [];
  private count = 0;

  constructor(
    private readonly page: Page,
    private readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  async start(): Promise<void> {
    const session = await this.page.context().newCDPSession(this.page);
    this.session = session;
    const size = this.page.viewportSize() ?? { width: 1280, height: 800 };
    const scale = await this.page.evaluate(() => window.devicePixelRatio);
    session.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const file = join(this.dir, `f${String(++this.count).padStart(6, '0')}.jpg`);
      this.frames.push({ file, t: (metadata.timestamp ?? Date.now() / 1000) * 1000 });
      this.writes.push(writeFile(file, Buffer.from(data, 'base64')));
      void session.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 92,
      maxWidth: Math.round(size.width * scale),
      maxHeight: Math.round(size.height * scale),
      everyNthFrame: 1,
    });
  }

  async stop(): Promise<Frame[]> {
    const session = this.session;
    if (!session) return this.frames;
    await session.send('Page.stopScreencast').catch(() => {});
    await Promise.all(this.writes);
    // The screencast only sends a frame when something changes; hold the last one until now.
    const last = this.frames.at(-1);
    if (last) this.frames.push({ file: last.file, t: Date.now() });
    await session.detach().catch(() => {});
    this.session = null;
    return this.frames;
  }
}
