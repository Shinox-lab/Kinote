import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/db/src/schema',
  out: './packages/db/migrations',
});
