import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ClipName } from './types';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const GIF_MAX_BYTES = 5 * 1024 * 1024;
const GIF_TRIES = [
  { width: 960, fps: 12 },
  { width: 800, fps: 10 },
  { width: 720, fps: 8 },
];
/** Gap between side-by-side views, in output pixels, filled with the app's page colour. */
const GAP = 24;

async function ffmpeg(args: string[]): Promise<void> {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
}

/** Numbered links to a sequence's frames, so ffmpeg can read it as an image sequence. */
function linkSequence(files: string[], dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  files.forEach((file, i) => symlinkSync(resolve(file), join(dir, `${String(i + 1).padStart(6, '0')}.jpg`)));
  return join(dir, '%06d.jpg');
}

/**
 * MP4 (H.264, yuv420p, faststart), a poster from the last frame, and for README clips a palette GIF of at most 5 MB.
 * Two sequences are put side by side with a gap.
 */
export async function encodeClip(
  name: ClipName,
  sequences: string[][],
  o: { fps: 30; readme: boolean; outDir: string; gifDir: string; workDir?: string },
): Promise<{ mp4: string; poster: string; gif?: string; seconds: number }> {
  const frames = Math.min(...sequences.map((s) => s.length));
  if (!Number.isFinite(frames) || frames === 0) throw new Error(`${name}: no frames to encode`);
  const work = o.workDir ?? join(o.outDir, `.${name}`);
  mkdirSync(o.outDir, { recursive: true });

  const inputs = sequences.flatMap((files, i) => ['-framerate', String(o.fps), '-i', linkSequence(files.slice(0, frames), join(work, `seq${i}`))]);
  const scale = 'scale=1920:-2:flags=lanczos:out_range=tv,format=yuv420p';
  const filter =
    sequences.length === 2
      ? `[0:v]pad=iw+${GAP}:ih:0:0:color=0xfcfbf9[l];[l][1:v]hstack=inputs=2,${scale}[v]`
      : `[0:v]${scale}[v]`;
  const mp4 = join(o.outDir, `${name}.mp4`);
  await ffmpeg([
    ...inputs,
    '-filter_complex', filter,
    '-map', '[v]',
    '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    mp4,
  ]);

  const poster = join(o.outDir, `${name}.jpg`);
  await ffmpeg(['-sseof', '-0.2', '-i', mp4, '-frames:v', '1', '-q:v', '3', '-update', '1', poster]);

  let gif: string | undefined;
  if (o.readme) {
    mkdirSync(o.gifDir, { recursive: true });
    gif = join(o.gifDir, `${name}.gif`);
    let made = false;
    for (const t of GIF_TRIES) {
      await ffmpeg([
        '-i', mp4,
        '-vf', `fps=${t.fps},scale=${t.width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
        gif,
      ]);
      if (statSync(gif).size <= GIF_MAX_BYTES) {
        made = true;
        break;
      }
    }
    if (!made) throw new Error(`${name}: GIF is over 5 MB even at ${GIF_TRIES.at(-1)!.width}px and ${GIF_TRIES.at(-1)!.fps} fps`);
  }

  rmSync(work, { recursive: true, force: true });
  return { mp4, poster, gif, seconds: frames / o.fps };
}
