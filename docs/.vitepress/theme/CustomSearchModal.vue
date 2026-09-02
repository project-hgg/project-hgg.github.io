<template>
  <Teleport to="body">
    <div class="custom-search-modal" @keydown.esc="close">
      <div class="backdrop" @click="close" />
      <div class="search-shell">
        <div class="search-bar">
          <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            placeholder="Search horror games or developers (e.g. Visage, MADiSON, Capcom)..."
            @keydown.down.prevent="navigateDown"
            @keydown.up.prevent="navigateUp"
            @keydown.enter.prevent="selectCurrent"
          />
          <button v-if="query" class="clear-btn" aria-label="Clear search" @click="query = ''">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <button class="close-btn" @click="close">ESC</button>
        </div>

        <div class="results-container">
          <div v-if="loading" class="loading-state">
            Loading game index...
          </div>

          <div v-else-if="results.length > 0" class="results-list">
            <a
              v-for="(item, idx) in results"
              :key="item.s"
              :href="getDirectoryUrl(item)"
              class="result-card"
              :class="{ selected: selectedIndex === idx }"
              @mouseenter="selectedIndex = idx"
              @click="openResult(item, $event)"
            >
              <div class="card-content">
                <span class="game-title">{{ item.t }}</span>
                <span class="game-meta">by {{ item.d || 'Unknown' }}</span>
              </div>
              <div class="card-actions">
                <span class="jump-tag">Jump to Row</span>
                <a
                  :href="'https://gamegata.xyz/game/' + item.s"
                  target="_blank"
                  rel="noopener"
                  title="View on hoGAMEGATA"
                  class="logo-link"
                  @click.stop
                >
                  <img src="/hgg.svg" class="icon-link hgg-icon" alt="hoGAMEGATA" />
                </a>
                <a
                  v-if="item.g"
                  :href="'https://www.igdb.com/search?q=' + encodeURIComponent(item.t)"
                  target="_blank"
                  rel="noopener"
                  title="View on IGDB"
                  class="logo-link"
                  @click.stop
                >
                  <img src="/IgdbLogo.svg" class="icon-link igdb-icon" alt="IGDB" />
                </a>
              </div>
            </a>
          </div>

          <div v-else-if="query.trim()" class="empty-state">
            No horror games found matching "<strong>{{ query }}</strong>"
          </div>

          <div v-else class="initial-state">
            Type a game title or developer name to search 18,000+ horror games...
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue'
import { useRouter } from 'vitepress'
import MiniSearch from 'minisearch'

const emit = defineEmits(['close'])
const router = useRouter()
const query = ref('')
const selectedIndex = ref(0)
const loading = ref(true)
const inputRef = ref<HTMLInputElement | null>(null)

interface GameDoc {
  id: string
  t: string
  s: string
  d: string
  g?: number
}

const results = ref<GameDoc[]>([])
let miniSearch: MiniSearch<GameDoc> | null = null
let allGames: GameDoc[] = []

function getLetterKey(title: string): string {
  const first = (title || '').trim().charAt(0).toUpperCase()
  return /[A-Z]/.test(first) ? first : '0-9'
}

function getDirectoryUrl(item: GameDoc): string {
  const letter = getLetterKey(item.t)
  return `/directory/${letter}.html#${item.s}`
}

onMounted(async () => {
  nextTick(() => {
    inputRef.value?.focus()
  })

  try {
    const res = await fetch('/search-index.json')
    const rawData = await res.json()
    allGames = rawData.map((item: any, i: number) => ({
      id: String(i),
      t: item.t,
      s: item.s,
      d: item.d || '',
      g: item.g || 0
    }))

    miniSearch = new MiniSearch<GameDoc>({
      fields: ['t', 'd'],
      storeFields: ['t', 's', 'd', 'g'],
      searchOptions: {
        fuzzy: (term) => (term.length > 3 ? 0.25 : null),
        prefix: true,
        boost: { t: 15, d: 5 },
        combineWith: 'OR',
        weights: {
          fuzzy: 0.45,
          prefix: 0.65,
        },
      }
    })

    miniSearch.addAll(allGames)
    loading.value = false
  } catch (err) {
    console.error('Failed to load search-index.json:', err)
    loading.value = false
  }
})

watch(query, (val) => {
  selectedIndex.value = 0
  const q = val.trim()
  if (!q) {
    results.value = []
    return
  }
  if (miniSearch) {
    const hits = miniSearch.search(q, {
      fuzzy: (term) => (term.length > 3 ? 0.25 : null),
      prefix: true,
      boost: { t: 15, d: 5 },
      combineWith: 'OR',
      weights: {
        fuzzy: 0.45,
        prefix: 0.65,
      },
    }).slice(0, 25)
    results.value = hits as unknown as GameDoc[]
  }
})

function close() {
  emit('close')
}

function navigateDown() {
  if (results.value.length > 0) {
    selectedIndex.value = (selectedIndex.value + 1) % results.value.length
  }
}

function navigateUp() {
  if (results.value.length > 0) {
    selectedIndex.value = (selectedIndex.value - 1 + results.value.length) % results.value.length
  }
}

function openResult(item: GameDoc, event?: Event) {
  if (event) event.preventDefault()
  const targetUrl = getDirectoryUrl(item)
  close()
  router.go(targetUrl)

  setTimeout(() => {
    const targetEl = document.getElementById(item.s)
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, 100)
}

function selectCurrent() {
  const selected = results.value[selectedIndex.value]
  if (selected) {
    openResult(selected)
  }
}
</script>

<style scoped>
.custom-search-modal {
  position: fixed;
  inset: 0;
  z-index: 999;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 80px;
}

.backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
}

.search-shell {
  position: relative;
  width: 100%;
  max-width: 720px;
  margin: 0 16px;
  background: #121215;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}

.search-bar {
  display: flex;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  gap: 12px;
  background: #18181b;
}

.search-icon {
  color: #a1a1aa;
  flex-shrink: 0;
}

.search-bar input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: #ffffff;
  font-size: 15px;
  font-family: inherit;
}

.clear-btn, .close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.08);
  border: none;
  color: #a1a1aa;
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.clear-btn:hover, .close-btn:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #ffffff;
}

.results-container {
  max-height: 460px;
  overflow-y: auto;
  padding: 8px;
}

.results-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.result-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-radius: 8px;
  text-decoration: none;
  background: transparent;
  border: 1px solid transparent;
  transition: all 0.15s ease;
  cursor: pointer;
}

.result-card.selected, .result-card:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
}

.card-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.game-title {
  color: #ffffff;
  font-weight: 700;
  font-size: 15px;
}

.game-meta {
  color: #a1a1aa;
  font-size: 13px;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.jump-tag {
  color: #a1a1aa;
  font-size: 11px;
  font-family: monospace;
  background: rgba(255, 255, 255, 0.06);
  padding: 3px 8px;
  border-radius: 4px;
}

.result-card.selected .jump-tag {
  color: #000000;
  background: #ffffff;
  font-weight: 600;
}

.logo-link {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
}

.icon-link {
  height: 20px;
  width: auto;
  transition: transform 0.15s ease, opacity 0.15s ease;
  opacity: 0.85;
}

.icon-link:hover {
  opacity: 1;
  transform: scale(1.15);
}

.hgg-icon {
  height: 24px;
}

.igdb-icon {
  height: 20px;
}

.loading-state, .empty-state, .initial-state {
  padding: 32px 16px;
  text-align: center;
  color: #a1a1aa;
  font-size: 14px;
}
</style>
