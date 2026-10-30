<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';
import type { ClipName } from './features';

const props = defineProps<{ name: ClipName; label?: string }>();

// Side-by-side clips are two 960-wide views with a 24 px gap.
const WIDE: ClipName[] = ['co-edit', 'review'];
const aspect = computed(() => (WIDE.includes(props.name) ? '1944 / 800' : '16 / 10'));

const video = ref<HTMLVideoElement | null>(null);
const reduced = ref(false);
let observer: IntersectionObserver | null = null;

onMounted(() => {
  const el = video.value;
  if (!el) return;
  reduced.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced.value) return;
  // Play only while on screen, so a page of clips doesn't decode them all at once.
  observer = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) el.play().catch(() => {});
      else el.pause();
    },
    { threshold: 0.25 },
  );
  observer.observe(el);
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="clip" :style="{ aspectRatio: aspect }">
    <video
      ref="video"
      :src="withBase(`/clips/${name}.mp4`)"
      :poster="withBase(`/clips/${name}.jpg`)"
      :controls="reduced"
      :aria-label="label"
      muted
      loop
      playsinline
      preload="metadata"
    />
  </div>
</template>

<style scoped>
.clip {
  width: 100%;
  background: var(--k-sidebar);
  border-radius: 10px;
  overflow: hidden;
}
.clip video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
