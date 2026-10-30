import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import ClipVideo from './ClipVideo.vue';
import Landing from './Landing.vue';
import './kinote.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Landing', Landing);
    app.component('ClipVideo', ClipVideo);
  },
} satisfies Theme;
