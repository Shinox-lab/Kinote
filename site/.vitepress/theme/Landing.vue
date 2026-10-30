<script setup lang="ts">
import { withBase } from 'vitepress';
import hosted from '../../hosted.json';
import ClipVideo from './ClipVideo.vue';
import { grid, heroClip, rows } from './features';

const commands = [
  'git clone https://github.com/Shinox-lab/Kinote.git',
  'cd Kinote && cp .env.example .env',
  'docker compose up -d',
];
</script>

<template>
  <div class="landing">
    <section class="hero">
      <h1>Write it down once.<br />Kinote files it everywhere it belongs.</h1>
      <p class="sub">
        A shared wiki for people and AI agents. Write a note, paste meeting notes or drop a file, and Kinote edits the
        right pages across your spaces, with a receipt, sources and Undo.
      </p>
      <div class="actions">
        <a class="btn primary" data-testid="try-kinote" :href="hosted.url">Try Kinote</a>
        <a class="btn" href="#self-host">Self-host</a>
      </div>
      <div class="window" data-testid="hero-clip">
        <div class="bar" aria-hidden="true"><i /><i /><i /></div>
        <ClipVideo :name="heroClip" label="A note is filed into two pages in two spaces" />
      </div>
    </section>

    <section id="features" class="rows">
      <article v-for="(row, i) in rows" :key="row.title" class="row" :class="{ flip: i % 2 === 1 }">
        <div class="text">
          <h2>{{ row.title }}</h2>
          <p>{{ row.body }}</p>
        </div>
        <div class="media">
          <ClipVideo v-if="row.clip" :name="row.clip" :label="row.title" />
        </div>
      </article>

      <h2 class="grid-title">And also</h2>
      <div class="grid">
        <article v-for="item in grid" :key="item.title" class="cell" :class="item.status">
          <h3>
            {{ item.title }}
            <span v-if="item.status === 'in-development'" class="chip">(In development)</span>
          </h3>
          <p>{{ item.body }}</p>
        </article>
      </div>
    </section>

    <section id="self-host" class="selfhost">
      <h2>Run it yourself</h2>
      <p>Kinote is open source under the MIT licence. You need Docker and a few minutes.</p>
      <pre><code><span v-for="c in commands" :key="c">{{ c }}<br /></span></code></pre>
      <p>
        Fill in the secrets in <code>.env</code> before the last command; the guide shows how. Then open
        <code>http://localhost:8081</code> and sign up the first account.
      </p>
      <a class="btn" :href="withBase('/self-host/')">Read the self-hosting guide</a>
    </section>

    <section id="hosted" class="hosted">
      <h2>Hosted Kinote is coming soon</h2>
      <p>
        We're getting a hosted version ready, so you can use Kinote without running a server. Until then, you can run
        it yourself with the commands above.
      </p>
    </section>

    <footer class="foot">
      <span>MIT licence</span>
      <a href="https://github.com/Shinox-lab/Kinote">GitHub</a>
      <a :href="withBase('/guide/')">Docs</a>
    </footer>
  </div>
</template>

<style scoped>
.landing {
  max-width: 1120px;
  margin: 0 auto;
  padding: 0 24px 48px;
  color: var(--k-fg);
}
h1,
h2,
h3 {
  border: 0;
  margin: 0;
  padding: 0;
  letter-spacing: -0.02em;
  color: var(--k-fg);
}
p {
  color: var(--k-muted);
  line-height: 1.6;
}
a {
  text-decoration: none;
}

.hero {
  text-align: center;
  padding: 72px 0 40px;
}
.hero h1 {
  font-size: clamp(32px, 5.4vw, 56px);
  line-height: 1.08;
  font-weight: 700;
}
.sub {
  max-width: 640px;
  margin: 20px auto 0;
  font-size: 18px;
}
.actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin: 28px 0 44px;
  flex-wrap: wrap;
}
.btn {
  display: inline-block;
  padding: 10px 20px;
  border-radius: 999px;
  border: 1px solid var(--k-line);
  background: var(--k-surface);
  color: var(--k-fg);
  font-weight: 600;
  font-size: 15px;
  transition: border-color 0.15s;
}
.btn:hover {
  border-color: var(--k-accent);
}
.btn.primary {
  background: var(--k-accent);
  border-color: var(--k-accent);
  color: var(--k-accent-fg);
}
.btn.primary:hover {
  background: var(--k-accent-text);
}

.window {
  max-width: 1040px;
  margin: 0 auto;
  border: 1px solid var(--k-line);
  border-radius: 14px;
  background: var(--k-surface);
  box-shadow: var(--k-shadow);
  overflow: hidden;
}
.window .clip {
  border-radius: 0;
}
.bar {
  display: flex;
  gap: 7px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--k-line);
  background: var(--k-sidebar);
}
.bar i {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--k-line);
}

.rows {
  padding-top: 56px;
}
.row {
  display: flex;
  align-items: center;
  gap: 48px;
  padding: 40px 0;
}
.row.flip {
  flex-direction: row-reverse;
}
.row .text {
  flex: 0 0 34%;
}
.row .media {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--k-line);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--k-shadow);
}
.row .media .clip {
  border-radius: 0;
}
.row h2 {
  font-size: 28px;
  font-weight: 680;
  line-height: 1.2;
}
.row p {
  margin-top: 12px;
  font-size: 17px;
}

.grid-title {
  font-weight: 680;
  margin-top: 56px;
  font-size: 24px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-top: 20px;
}
.cell {
  border: 1px solid var(--k-line);
  border-radius: 12px;
  background: var(--k-surface);
  padding: 18px 20px;
}
.cell h3 {
  font-size: 16px;
  font-weight: 650;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.cell p {
  margin: 6px 0 0;
  font-size: 14.5px;
}
.cell.in-development {
  background: transparent;
  border-style: dashed;
}
.chip {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  color: var(--k-muted);
  background: var(--k-sidebar);
  border: 1px solid var(--k-line);
  border-radius: 999px;
  padding: 1px 8px;
}

.selfhost,
.hosted {
  margin-top: 80px;
  padding: 36px;
  border: 1px solid var(--k-line);
  border-radius: 16px;
  background: var(--k-sidebar);
}
.selfhost h2,
.hosted h2 {
  font-size: 26px;
  font-weight: 680;
  margin-bottom: 8px;
}
.selfhost pre {
  margin: 18px 0;
  padding: 16px 18px;
  border-radius: 10px;
  background: var(--k-page);
  border: 1px solid var(--k-line);
  overflow-x: auto;
  font-size: 14px;
  line-height: 1.7;
}
.selfhost code,
.hosted code {
  font-size: 0.92em;
}
.hosted {
  margin-top: 24px;
  background: var(--k-accent-soft);
  border-color: transparent;
}
.hosted p {
  color: var(--k-fg);
  margin-bottom: 0;
}

.foot {
  display: flex;
  gap: 24px;
  justify-content: center;
  margin-top: 64px;
  color: var(--k-muted);
  font-size: 14px;
}
.foot a {
  color: var(--k-muted);
}
.foot a:hover {
  color: var(--k-accent-text);
}

@media (max-width: 960px) {
  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 767px) {
  .landing {
    padding: 0 16px 40px;
  }
  .hero {
    padding-top: 40px;
  }
  .sub {
    font-size: 16px;
  }
  .row,
  .row.flip {
    flex-direction: column;
    align-items: stretch;
    gap: 18px;
    padding: 28px 0;
  }
  .row h2 {
    font-size: 24px;
  }
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .selfhost,
  .hosted {
    padding: 24px 18px;
  }
}
</style>
