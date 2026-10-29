import type { PageSummary } from '@kinote/contracts';
import { ApiError, api } from './api.js';
import { slugify } from './console.js';

/**
 * Makes a page with a slug taken from its title. A slug that is already taken
 * is retried once with a short suffix, so the person never meets it.
 */
export async function createNamedPage(body: { space_id: string; parent_id: string | null; title: string }): Promise<PageSummary> {
  const slug = slugify(body.title) || 'page';
  try {
    return await api.createPage({ ...body, slug });
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'slug_taken') throw err;
    return api.createPage({ ...body, slug: `${slug}-${Math.random().toString(36).slice(2, 6)}` });
  }
}
