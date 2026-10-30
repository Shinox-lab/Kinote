import { defineConfig } from 'vitepress';

const base = '/Kinote/';
const siteUrl = 'https://shinox-lab.github.io/Kinote/';
const description =
  'A shared wiki for people and AI agents. Write a note once and Kinote edits the right pages across your spaces, with a receipt and Undo.';

export default defineConfig({
  base,
  title: 'Kinote',
  description,
  lang: 'en',
  cleanUrls: true,
  lastUpdated: false,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}mark.svg` }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: siteUrl }],
    ['meta', { property: 'og:title', content: 'Kinote' }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:image', content: `${siteUrl}social.png` }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  themeConfig: {
    logo: { light: '/logo-light.svg', dark: '/logo-dark.svg', alt: 'Kinote' },
    siteTitle: false,
    nav: [
      { text: 'Features', link: '/#features' },
      { text: 'Docs', link: '/guide/', activeMatch: '^/(guide|self-host|contributing)/' },
      { text: 'Roadmap', link: '/roadmap' },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/Shinox-lab/Kinote' }],
    sidebar: {
      '/guide/': [{ text: 'Using Kinote', items: [{ text: 'Workspaces, spaces and pages', link: '/guide/' }] }],
      '/self-host/': [{ text: 'Self-hosting', items: [{ text: 'Quick start', link: '/self-host/' }] }],
      '/contributing/': [{ text: 'Contributing', items: [{ text: 'Repo layout', link: '/contributing/' }] }],
    },
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/Shinox-lab/Kinote/edit/main/site/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Shinox-lab',
    },
  },
});
