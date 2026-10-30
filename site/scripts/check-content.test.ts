import { describe, expect, it } from 'vitest';
import { findBannedTerms, findReadmeIssues, findUnlabelledInDevelopment } from './check-content';

describe('findBannedTerms', () => {
  it('allows the GitHub org name', () => expect(findBannedTerms('github.com/Shinox-lab/Kinote')).toEqual([]));
  it('flags internal names', () => {
    expect(findBannedTerms('Built in Shinox during Phase C2, slice 3, by the Curator')).toEqual(['Shinox', 'Phase C2', 'slice 3', 'Curator']);
  });
  it('flags API keys', () => expect(findBannedTerms('key sk-or-v1-abc123def456ghi789jkl0')).toHaveLength(1));
});

describe('findUnlabelledInDevelopment', () => {
  it('passes labelled lines', () => expect(findUnlabelledInDevelopment('- **WhatsApp groups** (In development): …')).toEqual([]));
  it('flags unlabelled lines', () => expect(findUnlabelledInDevelopment('Sync from Google Drive')).toEqual(['Sync from Google Drive']));
});

describe('findReadmeIssues', () => {
  const ok = `<picture><source media="(prefers-color-scheme: dark)" srcset="site/public/logo-dark.svg"><img src="site/public/logo-light.svg"></picture>
[Try Kinote](https://shinox-lab.github.io/Kinote/#hosted)`;
  it('passes a good README', () => expect(findReadmeIssues(ok, 'https://shinox-lab.github.io/Kinote/#hosted', () => true)).toEqual([]));
  it('needs a dark logo', () => expect(findReadmeIssues(ok.replace('prefers-color-scheme: dark', ''), 'https://shinox-lab.github.io/Kinote/#hosted', () => true)).toContain('logo has no dark-theme source'));
  it('needs Try links to use the hosted URL', () => expect(findReadmeIssues(ok, 'https://example.org', () => true)).toContain('"Try Kinote" link is not the hosted URL'));
  it('reports missing local files', () => expect(findReadmeIssues(ok, 'https://shinox-lab.github.io/Kinote/#hosted', (p) => !p.includes('dark'))).toContain('missing file: site/public/logo-dark.svg'));
});
